# Ingest socket closes 4403 and 4426 stop retries

The relay's ingest socket can fail for passing reasons, such as a deploy during streaming hours, or for ones a retry never fixes. The dashboard closes with 4403 when it refuses the token and 4426 when the protocol version differs; an extension that hits either stops retrying that target and shows it until the target's settings change. Any other close, 1006 included, retries with backoff that starts at 1 s, doubles, caps at 30 s, and resets once a socket opens, so a deploy costs one quick reconnect. The token travels as the socket's first message because a browser websocket can't set headers. A first message that isn't a Token of this protocol version carries no token, and only another protocol version closes with 4426; a decode failure is caught so it can't leave the unauthenticated socket open.

Sites:

- `packages/relay/src/envelope.ts`
- `apps/extension/src/worker/target.ts`
- `apps/dashboard/src/server/market-live/trading-day.ts`

Source: apinrdw/kumora#45, apinrdw/kumora#157
