# Reading production data

Use this when research or a measurement needs real recorded data from a deployed stage: trades, candles or book chunks of a sealed day. The GETs are read-only and signed-in. `packages/relay/src/recorded-day.ts` lists their paths, and `target.ts` in `packages/deploy` builds each stage's URL.

## The session cookie

1. Ask the owner with `request_secret` (file delivery) for **the value of the `__Secure-better-auth.session_token` cookie**, from DevTools → Application → Cookies on the stage's dashboard. Name that cookie in the label. A request for "the Cookie header" gets back a `Set-Cookie` for `session_data`, which is only the session cache, and the owner has to paste a second time (wayfinder #256, 2026-11-13).
2. Send it as `Cookie: __Secure-better-auth.session_token=<value>`, reading the value from the secret file inside the command. Never print it.
3. Check it with one GET of the day strip (`DayStripPath`) before a long run. `{"error":"Unauthorized"}` means the wrong cookie.

## Measuring

- Node's `fetch` decodes `Content-Encoding` itself, so its body is already plain. Decoding it again throws `Decompression failed`. For the bytes on the wire, use `curl --compressed -w '%{size_download}'`.
- The tape GET answers 200 trades per request, so walking a whole-market window is slow: 10 minutes at the open took several minutes of requests. Run a short sample end to end before the full walk, and cache each window's result so a later failure doesn't throw it away.
