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

// The per-order token that ties an add-on line to its drink. The menu emits
// "g1", "g2", ...; the bound is generous enough that a different scheme would
// still pass, and tight enough that this can never carry a payload.
const LINE_GROUP = /^[A-Za-z0-9_-]{1,16}$/;

/*
 * The two config values, cleaned before use.
 *
 * A header value is bytes on the wire. A newline or a smart quote picked up
 * while pasting the secret into a terminal makes the whole subrequest
 * malformed, and the edge answers a bare 400 with an empty body — a failure
 * that names neither the cause nor the field.
 *
 * Surrounding whitespace is trimmed rather than rejected, because HTTP strips
 * it in transit anyway; trimming makes this Worker agree with the wire instead
 * of arguing with it. Anything else is refused up front by the guard in
 * fetch(), with a message that says what is wrong.
 */
// Printable ASCII, no spaces. Written as escapes rather than the literal
// `[!-~]` so the intent is readable without reaching for a code chart.
const HEADER_SAFE = /^[\x21-\x7E]+$/;

function posSecret(env) {
  return String(env.POS_PROXY_SECRET || '').trim();
}

// Same treatment, plus any trailing slash: POS_ORIGIN + '/api/...' would
// otherwise build a double slash, which some origins answer 404.
function posOrigin(env) {
  return String(env.POS_ORIGIN || '').trim().replace(/\/+$/, '');
}

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
    'X-POS-Proxy': posSecret(env),
    accept: 'application/json',
  };
  const ip = init.clientIp;
  if (ip) headers['CF-Connecting-IP'] = ip;
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  return fetch(posOrigin(env) + path, {
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

    // Misconfiguration, not a guest error.
    //
    // The missing binding is NAMED. "Ordering is not configured" on its own
    // sends whoever is on call guessing between the dashboard and the config
    // file, at the exact moment orders are failing. Only key names are
    // reported, never values -- both names are already public in this repo, so
    // there is nothing here an attacker did not have, and being able to read
    // it from a curl is worth far more than the pretence of hiding it.
    const secret = posSecret(env);
    const missing = [];
    if (!posOrigin(env)) missing.push('POS_ORIGIN');
    if (!secret) missing.push('POS_PROXY_SECRET');
    if (missing.length) {
      console.error('missing binding(s): ' + missing.join(', '));
      return json({ error: 'Ordering is not configured.', missing }, 503);
    }

    // A secret that cannot legally be a header value is caught HERE, where the
    // message can say so, rather than at the subrequest, where it surfaced as
    // an unexplained 400 with an empty body and cost a live debugging session.
    // The offending character class is named; the value never is.
    if (!HEADER_SAFE.test(secret)) {
      console.error('POS_PROXY_SECRET is not usable as an HTTP header value');
      return json({
        error: 'Ordering is not configured.',
        reason: 'POS_PROXY_SECRET contains characters that cannot go in an HTTP header. Use printable ASCII with no spaces — a newline or a smart quote picked up while pasting is the usual cause.'
      }, 503);
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
    // Body: { t, items: [{ productId, quantity, modifiers?, notes?,
    //                      lineGroup?, lineRole? }], phone? }
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
          // The guest's special request. Trimmed and capped here as well as at
          // the POS: this rebuild is an allow-list, so a field the POS accepts
          // still travels no further than this Worker unless it is named — and
          // a note left out here is a note the guest was shown in their sent
          // order and the kitchen never saw.
          if (typeof (line && line.notes) === 'string' && line.notes.trim()) {
            out.notes = line.notes.trim().slice(0, 500);
          }
          // Which drink an add-on belongs to. Named here for the same reason
          // as notes: the menu can send it all it likes, but an allow-list
          // drops what it does not list, and a dropped group is a cashier
          // guessing which cup the syrup went in.
          //
          // Shape-checked rather than passed through. The token is a short
          // opaque label the POS turns into a real parent line id, so nothing
          // needs to be readable in it — refusing anything longer or stranger
          // than that costs a regex and keeps arbitrary guest-supplied strings
          // out of a field the till will group rows by.
          if (typeof (line && line.lineGroup) === 'string' && LINE_GROUP.test(line.lineGroup)) {
            out.lineGroup = line.lineGroup;
            // A role without a group is meaningless, so it only travels with one.
            if (line.lineRole === 'addon') out.lineRole = 'addon';
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
