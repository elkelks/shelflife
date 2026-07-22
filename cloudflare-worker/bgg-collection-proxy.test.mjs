// Run with: node bgg-collection-proxy.test.mjs
// Spins up a local mock server that reproduces BGG's 202-then-200 behavior
// and drives the real proxy logic against it, so this exercises the actual
// retry loop rather than just asserting on mocks.

import http from 'node:http';
import assert from 'node:assert/strict';
import { handleRequest } from './bgg-collection-proxy-core.js';

const SAMPLE_XML = '<?xml version="1.0"?><items totalitems="1"><item objectid="1"><name>Wingspan</name><status own="1" prevowned="0"/><stats><rating value="9"/></stats></item></items>';

function startMockServer({ queuedCount, alwaysStatus }) {
  let hits = 0;
  let lastQuery = null;
  const server = http.createServer((req, res) => {
    hits++;
    lastQuery = req.url;
    if (alwaysStatus) {
      res.writeHead(alwaysStatus, { 'Content-Type': 'text/plain' });
      res.end(alwaysStatus === 404 ? 'Invalid username specified' : `status ${alwaysStatus}`);
      return;
    }
    if (hits <= queuedCount) {
      res.writeHead(202, { 'Content-Type': 'text/plain' });
      res.end('Your request for this collection has been accepted and will be processed. Please try again later for access.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(SAMPLE_XML);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}/xmlapi2/collection`, getHits: () => hits, getLastQuery: () => lastQuery });
    });
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS - ${name}`);
  } catch (err) {
    console.log(`FAIL - ${name}`);
    console.log(err);
    process.exitCode = 1;
  }
}

await test('retries through 202 twice then succeeds with 200 + CORS + XML body', async () => {
  const mock = await startMockServer({ queuedCount: 2 });
  const req = new Request('https://worker.example/?username=testuser&stats=1');
  const res = await handleRequest(req, { collectionUrl: mock.url, retryDelayMs: 20 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Content-Type'), 'application/xml; charset=utf-8');
  const body = await res.text();
  assert.equal(body, SAMPLE_XML);
  assert.equal(mock.getHits(), 3, 'expected 2 queued responses + 1 success = 3 upstream requests');
  assert.match(mock.getLastQuery(), /username=testuser/);
  assert.match(mock.getLastQuery(), /stats=1/);
  mock.server.close();
});

await test('missing username returns 400 without contacting upstream', async () => {
  const mock = await startMockServer({ queuedCount: 0 });
  const req = new Request('https://worker.example/');
  const res = await handleRequest(req, { collectionUrl: mock.url, retryDelayMs: 20 });
  assert.equal(res.status, 400);
  assert.equal(mock.getHits(), 0);
  mock.server.close();
});

await test('upstream 404 (unknown username) is passed through as-is', async () => {
  const mock = await startMockServer({ alwaysStatus: 404 });
  const req = new Request('https://worker.example/?username=doesnotexist');
  const res = await handleRequest(req, { collectionUrl: mock.url, retryDelayMs: 20 });
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.match(body, /Invalid username/);
  mock.server.close();
});

await test('exhausting retries while permanently queued returns 202 with a clear message', async () => {
  const mock = await startMockServer({ queuedCount: 999 });
  const req = new Request('https://worker.example/?username=testuser');
  const res = await handleRequest(req, { collectionUrl: mock.url, retryDelayMs: 5, maxAttempts: 3 });
  assert.equal(res.status, 202);
  assert.equal(mock.getHits(), 3);
  const body = await res.text();
  assert.match(body, /try again/i);
  mock.server.close();
});

await test('OPTIONS preflight returns 204 with CORS headers, no upstream call', async () => {
  const mock = await startMockServer({ queuedCount: 0 });
  const req = new Request('https://worker.example/?username=testuser', { method: 'OPTIONS' });
  const res = await handleRequest(req, { collectionUrl: mock.url });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(mock.getHits(), 0);
  mock.server.close();
});

console.log('\nAll tests completed.');
