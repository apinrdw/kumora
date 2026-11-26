# Production is served through zone routes on a proxied AAAA record

Production serves both apps on one host, `kumora.pusat.ai`: web at its root and the dashboard under `/dashboard` (`docs/adr/0020-the-dashboard-is-served-under-dashboard-on-every-stage.md`). A Worker Custom Domain can't share a host by path. It takes every request on its hostname and wins over zone routes, so it would take `/dashboard` from the dashboard. So each app's Production Worker gets zone routes on its Stage URL's host instead (`websiteProps`): web takes `kumora.pusat.ai/*`, and the dashboard takes `kumora.pusat.ai/dashboard` and `kumora.pusat.ai/dashboard/*`. The most specific route wins, and a web path such as `/dashboards-guide` stays with web. Routes need a proxied DNS record for the host. Web's Production stack owns one, AAAA `100::`, the address-less target for a host only Workers answer. The record also beats the zone's `*.pusat.ai` wildcard.

Cloudflare matches a route against the whole URL, query included, and a pattern may not hold a query or an infix wildcard (https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior). So `kumora.pusat.ai/dashboard?tab=brokers` misses both dashboard routes and reaches web. A `kumora.pusat.ai/dashboard*` route would catch it but also take `/dashboards-guide`. Web answers the bare base path with a 301 to `/dashboard/`, query kept, which the dashboard's `/dashboard/*` route takes.

The `prod` Cloudflare token needs DNS Edit and Workers Routes Edit on the zone for this (`docs/runbooks/deploy.md`, step 15). Moving to a Custom Domain means giving the dashboard its own host, which reverses `docs/adr/0020-the-dashboard-is-served-under-dashboard-on-every-stage.md`.

Sites:
- `packages/deploy/src/stack.ts`
- `apps/web/alchemy.run.ts`
- `apps/web/src/server/dashboard-redirect.ts`

Source: apinrdw/kumora#687
