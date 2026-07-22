// Core proxy logic, kept in its own module (no `export default`) so it can
// be unit tested directly under plain Node without going through the
// Workers runtime. The Workers entry point (bgg-collection-proxy.js) is the
// only file that exports a default handler - Cloudflare's module loader
// inspects every top-level export of that file as a potential handler
// binding, so extra named exports there (like this module used to have)
// break deployment even though they work fine under plain Node.

export const BGG_COLLECTION_URL = 'https://boardgamegeek.com/xmlapi2/collection';
export const MAX_ATTEMPTS = 8;
export const RETRY_DELAY_MS = 1500;
// Public, read-only collection data with no auth/cookies involved, so an
// open origin is fine - there's nothing here that needs restricting to a
// specific caller.
const ALLOWED_ORIGIN = '*';

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// options lets tests point at a mock server and use short delays; production
// calls (see bgg-collection-proxy.js) use the real BGG URL and the defaults.
export async function handleRequest(request, { collectionUrl = BGG_COLLECTION_URL, maxAttempts = MAX_ATTEMPTS, retryDelayMs = RETRY_DELAY_MS } = {}) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const incomingUrl = new URL(request.url);
  const username = incomingUrl.searchParams.get('username');
  if (!username) {
    return new Response('Missing required "username" query parameter.', {
      status: 400,
      headers: { ...corsHeaders(), 'Content-Type': 'text/plain' },
    });
  }

  const upstreamUrl = new URL(collectionUrl);
  incomingUrl.searchParams.forEach((value, key) => upstreamUrl.searchParams.set(key, value));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const upstreamResponse = await fetch(upstreamUrl.toString(), {
      headers: { 'User-Agent': 'shelflife-bgg-proxy (+https://github.com/elkelks/shelflife)' },
    });

    if (upstreamResponse.status === 200) {
      const xml = await upstreamResponse.text();
      return new Response(xml, {
        status: 200,
        headers: { ...corsHeaders(), 'Content-Type': 'application/xml; charset=utf-8' },
      });
    }

    if (upstreamResponse.status === 202) {
      if (attempt < maxAttempts - 1) await sleep(retryDelayMs);
      continue;
    }

    // Any other status (404 unknown user, 429 rate limited, 5xx, ...) - stop
    // and pass BGG's own message straight through rather than guessing.
    const bodyText = await upstreamResponse.text();
    return new Response(bodyText || `BGG returned HTTP ${upstreamResponse.status}.`, {
      status: upstreamResponse.status,
      headers: { ...corsHeaders(), 'Content-Type': 'text/plain' },
    });
  }

  // Still queued after every retry - ask the caller to try again later
  // rather than holding the connection open indefinitely.
  return new Response(
    'BGG is still generating this collection export after several retries. Please try again in a moment.',
    { status: 202, headers: { ...corsHeaders(), 'Content-Type': 'text/plain' } }
  );
}
