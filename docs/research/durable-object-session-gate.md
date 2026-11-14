# How the Market Live websocket upgrade checks a Better Auth session

Research for the ticket "How the Market Live websocket upgrade checks a Better Auth session" (apinrdw/kumora#68), on the map "Sign in to the dashboard with Better Auth on D1" (#63). Read 2026-11-07.

Market Live is not built yet. This note works from its decided design: the viewer and ingest websockets from "What the relay sends the dashboard" (#45), and the past-day HTTP GETs from "How Market Live loads a past trading day from its Durable Object" (#64). Both are served by a per-trading-day Durable Object in the dashboard Worker.

## Answer

The dashboard Worker checks the session itself, in its own `fetch`, before it calls the Durable Object stub. The Durable Object never sees an unauthenticated request.

- The browser sends the session cookie with the upgrade on `workers.dev` and under `alchemy dev`, because the socket has the same origin as the page.
- A check costs one HMAC verify of the signed cookie, plus 2 D1 row reads when Better Auth's cookie cache is off or has expired. With the cookie cache on, most checks read no D1 rows.
- A failed check can't be a plain `401`. The browser WebSocket API hides the handshake status. Instead, the Worker accepts a socket pair itself and closes it with an application close code, for example `4401`. This uses the same close-with-reason channel that #45 already uses for version mismatches.
- The ingest socket is on its own path. It checks the ingest token and never the session.
- Gating the past-day GETs keeps their cache, because the Worker runs before the Cache API. The Worker checks the session, then looks up a cache key that it builds from the URL alone, so the cookie never enters the key.

Separate from the gate: the current Cache API page lists custom domains as working and no longer says that `*.workers.dev` has no effect. Older versions of the page said it did. Check this on a deployed stage before #64 counts on the cache. See Open questions.

## 1. Does the session cookie reach the upgrade request?

Yes, on every stage, as long as the page opens the socket on its own origin (`wss://<worker>.workers.dev/...`, or `ws://localhost:3001/...` in dev).

- **Browser.** A WebSocket handshake is an HTTP GET. The browser sends it through Fetch in credentials mode `include`, so it carries the origin's cookies ([WHATWG WebSockets, "establish a WebSocket connection"](https://websockets.spec.whatwg.org/#concept-websocket-establish); [RFC 6455 §4.1](https://www.rfc-editor.org/rfc/rfc6455#section-4.1)). Cookies are matched by host, not port or scheme family, so `ws://localhost:3001` gets the cookie set by `http://localhost:3001`.
- **Better Auth's cookie attributes.** These are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` only when secure cookies are on ([`createCookieGetter`, better-auth 1.7.18 `dist/cookies/index.mjs`](https://github.com/better-auth/better-auth/blob/v1.7.18/packages/better-auth/src/cookies/index.ts)). A same-origin socket is same-site, so a `Lax` cookie goes out.
- **`workers.dev` is a public suffix** ([PSL line `workers.dev`](https://publicsuffix.org/list/public_suffix_list.dat)). Each Worker hostname is its own site. Production, staging, and each preview keep separate cookies, which matches "one D1 per stage". A page on another `*.workers.dev` Worker is cross-site, so `Lax` keeps its cookie off a forged upgrade. Still check `Origin` (see the recipe), because cookie rules are not a CSRF control for websockets.
- **Cookie name changes per stage.** Better Auth adds the `__Secure-` prefix when `baseURL` starts with `https://`. Without a `baseURL`, it falls back to `NODE_ENV === "production"` ([same source](https://github.com/better-auth/better-auth/blob/v1.7.18/packages/better-auth/src/cookies/index.ts)). Deployed stages get `__Secure-better-auth.session_token`, and dev gets `better-auth.session_token`. This is harmless if every read goes through `auth.api.getSession`. Code that parses the cookie by hand breaks. Set `baseURL` per stage, as Alchemy's Better Auth example does with `AUTH_BASE_URL` (`repos/alchemy/examples/cloudflare-domain-better-auth/src/Auth.ts`).
- **`alchemy dev`.** The Vite dev server's upgrade listener relays the handshake to local workerd over a raw TCP tunnel. It copies every request header, `Cookie` included (`proxyRequestHeaders`, `repos/alchemy/packages/cloudflare-runtime/src/vite/forwarded-host.ts`). It relays the Worker's answer byte for byte, "whether a 101 or a refusal (a 403, a 404, ...)" (`repos/alchemy/packages/cloudflare-runtime/src/vite/websockets.ts`). Vite's own HMR sockets are recognised by `Sec-WebSocket-Protocol: vite*` and skipped. Dev behaves like deploy.

## 2. Does the Worker check before forwarding, and what does it cost?

**Where.** In the dashboard Worker's `fetch`, before `env.TRADING_DAY.get(id).fetch(request)`. Cloudflare's guide forwards upgrades with `stub.fetch(request)` after the Worker inspects the request. It says: "Validate requests in your Worker to avoid billing for invalid requests against a Durable Object" ([Durable Objects: Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). A Durable Object namespace is reachable only through its binding, so the Worker's check is the only door.

**How Alchemy wires it.** `Cloudflare.Website.Vite` takes a `main` that wraps the framework's handler and re-exports the Durable Object classes. Its docs say: "When the Worker must export more than the framework's fetch handler — Durable Object classes, additional handlers — point `main` at your own module" (`repos/alchemy/packages/cloudflare/src/Website/Vite.ts`). The binding goes in `env` as `Cloudflare.DurableObject("TradingDay", { className: "TradingDay" })`, as in `repos/alchemy/examples/cloudflare-agents/alchemy.run.ts`. TanStack Start's custom entry is `createServerEntry({ fetch(request, opts) { return handler.fetch(request, opts) } })` from `@tanstack/react-start/server-entry`. It names Durable Objects as something to add there ([TanStack Start: Server Entry Point](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point)). Today `apps/dashboard/alchemy.run.ts` passes no `main` or `env`, so Market Live adds both.

Route the Market Live paths in that entry, before `handler.fetch`, rather than in a TanStack Start server route. The entry gets the raw `Request` and returns the stub's `101` response untouched. A server route goes through Start's request pipeline, and nothing in Start's docs promises that a `Response` carrying `webSocket` survives it.

**What `getSession` does** ([`/get-session`, better-auth 1.7.18 `dist/api/routes/session.mjs`](https://github.com/better-auth/better-auth/blob/v1.7.18/packages/better-auth/src/api/routes/session.ts)):

1. It verifies the signed `session_token` cookie with an HMAC over the secret. This is CPU only.
2. With `session.cookieCache.enabled` and a valid `session_data` cookie, it returns the cached session and user. There is no database read. The cache lives `cookieCache.maxAge` seconds (default 300).
3. Otherwise it runs `internalAdapter.findSession(token)`, a `findOne` on `session` by `token` with `join: { user: true }`. Without `advanced.database.joins`, the adapter factory runs the join as separate queries ([`@better-auth/core` 1.7.18 `dist/db/adapter/factory.mjs`](https://github.com/better-auth/better-auth/blob/v1.7.18/packages/core/src/db/adapter/factory.ts)). That is 2 indexed point reads, or 2 D1 rows.
4. Once per `updateAge` (default 1 day), it also writes the new `expiresAt` and sets a fresh cookie.

Alchemy's `BetterAuth(...).getSession(headers)` calls `auth.api.getSession({ headers })` on a Better Auth instance built once per execution (`repos/alchemy/packages/better-auth/src/BetterAuth.ts`).

**Cost per upgrade.** D1 bills rows read: the Free plan includes 5 million a day, and the Paid plan includes 25 billion a month, then $0.001 per million ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)). At 2 rows per check, upgrades cost almost nothing. The real cost is latency: a D1 round trip on each connect and reconnect. The cookie cache removes it for most checks. The Durable Object side gains nothing new: creating a socket was always one Durable Object request ([Durable Objects pricing, note 2](https://developers.cloudflare.com/durable-objects/platform/pricing/)). A rejected upgrade now costs nothing there, because it never reaches the object.

**Passing identity on.** The Worker can add a header, such as the user id, to the request it forwards. The Durable Object stores it with `ws.serializeAttachment(...)` (16 KiB limit, survives hibernation) ([Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). That is only for logs or per-viewer limits. Under the owner's rule (check on upgrade only), the Durable Object doesn't re-check.

## 3. What does a failed check return?

**A plain `401` is invisible to the page.** When a handshake fails, the browser "fails the WebSocket connection": it fires `error`, then `close` with code `1006` and no reason. It never exposes the HTTP status ([WHATWG WebSockets](https://websockets.spec.whatwg.org/#feedback-from-the-protocol)). An expired session would look the same as a dropped network, and the reconnect loop would retry forever.

Choose one of these:

- **A (recommended): accept, then close with a code.** In the Worker, not the Durable Object: create a `WebSocketPair`, `server.accept()`, `server.close(4401, "sign-in required")`, and return `new Response(null, { status: 101, webSocket: client })` ([Workers WebSockets API](https://developers.cloudflare.com/workers/runtime-apis/websockets/)). Codes 4000–4999 are for applications ([RFC 6455 §7.4.2](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2)). The page reads `event.code === 4401`, stops reconnecting, and sends the viewer to sign-in with a return URL. #45 already closes the socket with a reason for "new version, reload", so Market Live handles one close-code table instead of two signals.
- **B: plain `401`, and the page asks.** On any `1006`, the page calls `authClient.getSession()` (`GET /api/auth/get-session`) before it reconnects. If the result is `null`, it sends the viewer to sign-in. This costs an extra request on every drop.

Either way, the first page load is already gated by the dashboard-wide route guard. Only a session that ends while the page is open, through expiry, sign-out elsewhere, or a ban, reaches this path. With A, a non-browser client still sees `101`. Return a plain `401` when the request has no `Origin` header, if that matters.

## 4. The extension's ingest socket

It keeps its token and needs no session. Give it its own path, such as `/market-live/ingest`, and keep it separate from the viewer's `/market-live/live`. Route on the path first, then apply exactly one check: the ingest token (constant-time compare) for ingest, the session for viewer paths. The extension's service worker connects from a `chrome-extension://` origin, so a session check would fail there anyway. It must never run on that path.

## 5. Does gating the past-day GETs break their cache?

No, if the order is right. "Cloudflare Workers run before the cache", and the Cache API "works as an ephemeral key-value store, with the request URL as the key" ([How the cache works](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)). The cache key is whatever `Request` the Worker passes to `cache.match`/`cache.put` ([Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)). So:

1. Check the session, using the cookie cache.
2. Build the key from the URL alone: `new Request(url.origin + url.pathname + url.search)`. No cookie means one shared entry per day, code, or second for every viewer.
3. On a hit, return it. On a miss, fetch from the Durable Object, `cache.put` it, and return it.

Pitfalls:

- **`Set-Cookie`.** "Responses with `Set-Cookie` headers are never cached" ([Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)). `getSession` may refresh cookies. Put those on the outgoing response only, never on the object handed to `cache.put`.
- **Browser and shared caches.** Send `Cache-Control: private, max-age=31536000, immutable`, not `public`. The data is now behind sign-in, and no proxy should keep it.
- **Check volume.** During Play, #64 fetches the tape up to 4 times a second per viewer. With the cookie cache off, that is about 8 D1 rows a second per viewer, plus a D1 round trip on each fetch. Turn the cookie cache on.

## Recommended shape

- `apps/dashboard` gets a custom Worker entry (`main`). It routes `/market-live/ingest` (token), `/market-live/live` (session, then the trading day's Durable Object), and `/market-live/days/*` (session, then the Cache API, then the Durable Object). Everything else goes to TanStack Start's `handler.fetch`. The entry exports the trading-day and index Durable Object classes.
- Viewer upgrade: check the `Origin` header, then `getSession`. Reject with accept-and-close `4401`. On success, forward to `stub.fetch(request)`, adding a user-id header.
- Better Auth: `session.cookieCache: { enabled: true, maxAge: 300 }` and `baseURL` per stage. The gate also requires `user.emailVerified`, because the owner ruled that an unverified account sees no data. `requireEmailVerification` already blocks password sign-in before verification, so this is a backstop.

## Trade-off the map should know

The cookie cache means a ban or a revoked session can still pass the gate for up to `maxAge` (5 minutes). The admin plugin's ban deletes the user's sessions (`deleteUserSessions` in `dist/plugins/admin/routes.mjs`), but a `session_data` cookie signed before the ban stays valid until it expires. Under "check on upgrade only", an open socket outlives a ban anyway, so this widens the window for reconnects and past-day GETs only. If that's not acceptable, the gate can call `getSession` with `query: { disableCookieCache: true }` for the upgrade only, which costs 2 D1 rows per connect, and keep the cache for the GETs.

## Open questions

- **Cache API on `*.workers.dev`.** The current [Cache API page](https://developers.cloudflare.com/workers/runtime-apis/cache/) says "Workers deployed to custom domains have access to functional `cache` operations". It mentions `.workers.dev` cache keys but no longer says operations there "will have no impact". Older copies of the page and community answers said they did. Market Live runs on `workers.dev`, so check `cache.put` then `cache.match` on staging before #64's immutable cache counts on it. If it doesn't work, the fallback is a custom domain, or serving sealed days from the Durable Object (or R2) without the edge cache.
- **Accept-and-close timing.** Option A relies on workerd delivering a close frame queued before the `101` is returned. Confirm with one local test under `alchemy dev`. If it fails, use option B.
- Session length and "remember me" are still unspecified on the map. They set how often reconnects find an expired session, not how the gate works.
