# Broker codes answers allow any origin

The extension's manifest grants only Production's host, so the extension reaches an extra target cross-origin. Every broker codes answer (401, 426 and 400 too) therefore allows any origin, and a preflight is answered before the token check. This is safe because the token is a bearer header, never a cookie.

Sites:

- `apps/dashboard/src/server/market-live/broker-codes-route.ts`

Source: apinrdw/kumora#244
