# Production alone redirects other hosts to its Stage URL

Production's dashboard is served at `kumora.pusat.ai/dashboard` through zone routes, but its Worker keeps its workers.dev URL, where old bookmarks and an old relay build still point. On Production alone, the Worker entry answers a request on any host but the Stage URL's with a 301 to the Stage URL's host, the path joined under `/dashboard` and the query kept (`src/server/base-redirect.ts`). The stack binds `REDIRECT_TO_STAGE_URL` on Production only. Every other Stage's Stage URL is its Worker's only host, and comparing hosts there would send a version preview or a local alias such as `127.0.0.1` away from what it asked for.

Sign-in, Turnstile and the Market Live origin check accept only the Stage URL, so the workers.dev URL can't keep serving the dashboard. WebSocket clients don't follow the 301, so a relay build that still targets workers.dev stops sending until it is rebuilt and reloaded (`docs/runbooks/deploy.md`).

Sites:
- `apps/dashboard/alchemy.run.ts`
- `apps/dashboard/src/server/base-redirect.ts`

Source: apinrdw/kumora#687
