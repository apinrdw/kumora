# A second runner hands back the HTTP error

Some code answers an HTTP error differently per surface: the dashboard's Worker entry closes a socket with 4401, returns 401 JSON, or returns 403 on ingest. For that code the bridge has a second runner, `runServerEffectResult`, which hands back the HTTP error, or the bare 500 Response for anything else, instead of throwing, so each surface can shape its own answer.

Sites:
- `packages/server/src/bridge.ts`

Source: apinrdw/kumora#81
