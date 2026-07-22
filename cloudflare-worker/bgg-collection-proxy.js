// Thin proxy for BoardGameGeek's XML API2 collection endpoint. Solves the two
// problems a browser can't solve on its own:
//
//   1. BGG sends no Access-Control-Allow-Origin header, so a browser blocks a
//      direct fetch() to boardgamegeek.com from any other origin.
//   2. BGG's collection endpoint is asynchronous: the first request often
//      returns 202 ("please try again later") while the export is built, so
//      the caller has to poll until it's ready.
//
// This worker does the polling server-side (server-to-server requests aren't
// subject to CORS) and returns the final XML with CORS unlocked. It does not
// interpret the XML at all - every query param is passed straight through to
// BGG, so the caller (shelflife's client-side JS) controls exactly what's
// requested (e.g. stats=1 for ratings).
//
// Usage:  GET <worker-url>/?username=<bgg-username>&stats=1
//
// The actual proxy/retry logic lives in bgg-collection-proxy-core.js. It's
// kept out of this file because Cloudflare's module loader inspects every
// top-level export here as a potential handler binding - this file must
// export nothing but `default`, or deployment fails.

import { handleRequest, corsHeaders } from './bgg-collection-proxy-core.js';

export default {
  async fetch(request) {
    try {
      return await handleRequest(request);
    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, {
        status: 502,
        headers: { ...corsHeaders(), 'Content-Type': 'text/plain' },
      });
    }
  },
};
