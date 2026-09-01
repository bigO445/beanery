/**
 * beanery-cafe.com — Worker entry.
 *
 * Serves the landing page and the QR menu from static assets, and is the ONLY
 * route from a guest's phone to the POS ordering API.
 *
 * WHY A WORKER AND NOT A DIRECT CALL
 *
 * The POS lives on its own hostname. If the menu called it from the browser,
 * that hostname would be in every guest's network tab, the request would be
 * cross-origin (so the POS would need CORS opened to this site), and the
 * ordering API would be reachable by anyone who read the URL.
 *
 * Going through here instead means the guest only ever talks to
 * beanery-cafe.com — same origin, no CORS — and this Worker adds a shared
 * secret the POS checks. The POS already expects exactly this: see `proxyGuard`
 * in the POS's lib/qr-ordering.js, which 404s anything arriving without the
 * header once PUBLIC_PROXY_SECRET is set.
 *
 * Hiding the hostname is not the security control — hostnames leak, from logs,
 * DNS history, a screenshot. The secret is. With it set, someone who learns the
 * POS origin still cannot place an order against it.
 *
 * NOT AN OPEN PROXY
 *
 * Three exact routes are forwarded and nothing else. There is deliberately no
 * "forward whatever path came in" branch: that would turn this Worker into a
 * public front door for every authenticated route on the POS, with the secret
 * helpfully attached.
 *
 * Bindings (wrangler.jsonc + dashboard):
 *   POS_ORIGIN         var    e.g. https://beanery.base60labs.io — no trailing slash
 *   POS_PROXY_SECRET   secret must equal PUBLIC_PROXY_SECRET on the POS
 *   ASSETS             static assets binding (the built dist/)
 */

// The QR token is 32 random bytes hex-encoded by the POS (newQrToken). Checking
// the shape here keeps obvious junk — a scanned barcode, a truncated paste, a
// probe — off the POS entirely, and costs one regex.
const QR_TOKEN = /^[a-f0-9]{64}$/;

// The POS caps the order body at 64kb. Matching that here means an oversized
// body is refused at the edge instead of crossing the network to be refused
// there.
const MAX_ORDER_BYTES = 64 * 1024;

// A publicId is 16 random bytes hex-encoded (newPublicId).
const PUBLIC_ID = /^[a-f0-9]{32}$/;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // A guest's order status is theirs alone and changes as the counter works on
  // it; nothing here should ever sit in a cache.
  'cache-control': 'no-store',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/*
 * Build the upstream request.
 *
 * Only headers we choose are forwarded. The incoming request's headers are NOT
 * passed through: a guest's cookies, Authorization, or a spoofed X-POS-Proxy
 * have no business reaching the POS, and forwarding an inbound header set is
 * how a proxy accidentally becomes a confused deputy.
 *
 * CF-Connecting-IP is the exception, and it is set by Cloudflare on the way in,
 * not by the client. The POS rate-limits guest ordering per client address;
 * without this every guest would look like one IP and a single customer could
 * lock out the whole cafe. The POS only trusts it on a request that already
 * proved it came through this proxy.
 */
function upstream(env, path, init = {}) {
  const headers = {
    'X-POS-Proxy': env.POS_PROXY_SECRET,
    accept: 'application/json',
  };
  const ip = init.clientIp;
  if (ip) headers['CF-Connecting-IP'] = ip;
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  return fetch(env.POS_ORIGIN + path, {
    method: init.method || 'GET',
    headers,
    body: init.body,
    // The POS answers from its own database in single-digit milliseconds; a
    // request still open after 10s is a POS that is down, and a guest staring
    // at a spinner should be told so rather than waiting out a default.
    signal: AbortSignal.timeout(10_000),
  });
}

/*
 * Hand the POS's answer back to the guest.
 *
 * The status and the JSON body pass through so the menu can react to a real 404
 * (bad token), 429 (too many orders on this table) or 400 (item sold out) — the
 * POS writes guest-appropriate messages for all of them.
 *
 * On a transport failure the POS origin must not appear in the response. A
 * fetch error message can contain the hostname, which is exactly the thing this
 * Worker exists to keep out of the browser.
 */
async function relay(promise) {
  let res;
  try {
    res = await promise;
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return json(
      { error: timedOut ? 'The kitchen system is not responding. Try again in a moment.' : 'Service unavailable.' },
      503
    );
  }

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // The POS answered with something that is not JSON — an nginx error page,
    // say. Passing it through would leak whatever it says about the origin.
    return json({ error: 'Service unavailable.' }, 502);
  }
  return json(body, res.status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Everything that is not the ordering API is the website: the landing page,
    // the menu, images, CSS. Checked first because it is almost every request.
    if (!pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (!env.POS_ORIGIN || !env.POS_PROXY_SECRET) {
      // Misconfiguration, not a guest error. Say so plainly in the log and give
      // the guest something true but uninformative.
      console.error('POS_ORIGIN and POS_PROXY_SECRET must both be set');
      return json({ error: 'Ordering is not configured.' }, 503);
    }

    const clientIp = request.headers.get('CF-Connecting-IP') || '';

    // ── GET /api/menu?t=<qrToken> ─────────────────────────────────────────
    // The live catalogue for the table this QR belongs to: real product ids,
    // current prices, and which items are sold out right now.
    if (pathname === '/api/menu' && request.method === 'GET') {
      const t = url.searchParams.get('t') || '';
      if (!QR_TOKEN.test(t)) return json({ error: 'not found' }, 404);
      return relay(upstream(env, '/api/public/menu?qrToken=' + t, { clientIp }));
    }

    // ── POST /api/order ───────────────────────────────────────────────────
    // Body: { t, items: [{ productId, quantity, modifiers? }], phone? }
    //
    // The token is rewritten into the field name the POS expects rather than
    // having the menu know that name. Prices are NOT sent and would be ignored
    // if they were — the POS prices every line from its own catalogue, which is
    // what stops a guest editing the total in devtools.
    if (pathname === '/api/order' && request.method === 'POST') {
      const raw = await request.text();
      if (raw.length > MAX_ORDER_BYTES) return json({ error: 'Order too large.' }, 413);

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: 'Bad request.' }, 400);
      }

      const t = (body && body.t) || '';
      if (!QR_TOKEN.test(t)) return json({ error: 'not found' }, 404);
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return json({ error: 'items required' }, 400);
      }

      // Rebuilt field by field rather than spread: whatever else the page sent
      // is not forwarded, so a future field on the POS cannot be reached from
      // the browser just because someone added it to the request.
      const payload = {
        qrToken: t,
        items: body.items.slice(0, 50).map((line) => {
          const out = {
            productId: String((line && line.productId) || ''),
            quantity: Number((line && line.quantity) || 0),
          };
          if (Array.isArray(line && line.modifiers) && line.modifiers.length) {
            out.modifiers = line.modifiers.slice(0, 20).map((m) => ({
              groupId: String((m && m.groupId) || ''),
              optionId: String((m && m.optionId) || ''),
            }));
          }
          return out;
        }),
      };
      if (typeof body.phone === 'string' && body.phone.trim()) {
        payload.phone = body.phone.trim().slice(0, 40);
      }

      return relay(
        upstream(env, '/api/public/orders', {
          method: 'POST',
          body: JSON.stringify(payload),
          clientIp,
        })
      );
    }

    // ── GET /api/order/<publicId>?t=<qrToken> ─────────────────────────────
    // Lets the menu show "the counter has your order" without the guest
    // refreshing. The token rides along because the POS rate-limits on it.
    const statusMatch = pathname.match(/^\/api\/order\/([a-f0-9]{32})$/);
    if (statusMatch && request.method === 'GET') {
      const publicId = statusMatch[1];
      const t = url.searchParams.get('t') || '';
      if (!PUBLIC_ID.test(publicId) || !QR_TOKEN.test(t)) return json({ error: 'not found' }, 404);
      return relay(upstream(env, '/api/public/orders/' + publicId, { clientIp }));
    }

    // An unmatched /api/ path is not a route this site has. 404 rather than
    // falling through to the assets handler, which would answer the 404 page in
    // HTML to something that asked for JSON.
    return json({ error: 'not found' }, 404);
  },
};
