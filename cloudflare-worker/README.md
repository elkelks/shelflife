# shelflife-bgg-proxy

A minimal Cloudflare Worker that proxies BoardGameGeek's `xmlapi2/collection`
endpoint so it can be called directly from the browser. It exists solely to
work around two things a static page can't handle on its own:

1. **No CORS on BGG's side.** `boardgamegeek.com` never sends
   `Access-Control-Allow-Origin`, so browsers block a direct `fetch()` from
   any other origin. This worker makes the request server-to-server (not
   subject to CORS) and adds the header on the way back.
2. **Async collection requests.** BGG's collection endpoint often replies
   `202 Accepted` on the first call while it builds the export, and expects
   the caller to poll until it's ready. This worker does that polling
   internally (up to 8 attempts, ~1.5s apart) so the browser only ever sees
   one request.

It does **not** parse the XML - it passes every query param straight through
to BGG and returns the raw XML response. Parsing stays in `index.html`,
alongside the existing CSV-parsing logic.

## Files

- `bgg-collection-proxy-core.js` - the actual proxy/retry logic. No
  `export default`, so it's safe to unit test directly under plain Node.
- `bgg-collection-proxy.js` - the Workers entry point (`main` in
  `wrangler.toml`). Only exports `default` - Cloudflare's module loader
  treats every top-level export of the entry file as a potential handler
  binding, so anything else here breaks deployment.
- `bgg-collection-proxy.test.mjs` - run with `node bgg-collection-proxy.test.mjs`.
  Spins up a local mock server that reproduces BGG's 202-then-200 behavior
  and drives the real retry loop against it.
- `wrangler.toml` - deployment config.

## Deploying

This needs to be deployed from a machine with access to your Cloudflare
account - I can't do that on your behalf. From this directory:

```bash
npx wrangler login      # opens a browser to authorize your Cloudflare account
npx wrangler deploy     # publishes to https://shelflife-bgg-proxy.<your-subdomain>.workers.dev
```

`wrangler deploy` prints the final worker URL when it finishes.

## Using it from the browser

```js
const res = await fetch(`https://shelflife-bgg-proxy.<your-subdomain>.workers.dev/?username=${encodeURIComponent(username)}&stats=1`);
if (!res.ok) {
  if (res.status === 202) {
    // BGG is still generating the export after every retry - try again shortly.
  }
  // other statuses (400 missing username, 404 unknown username, 429 rate
  // limited, 502 proxy error) - res.text() has a human-readable message.
}
const xmlText = await res.text();
const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
```

`index.html` doesn't call this yet - wiring it into the upload flow (and
deciding whether CSV upload stays as a fallback) is a separate step once
this is deployed and you have a worker URL to point at.
