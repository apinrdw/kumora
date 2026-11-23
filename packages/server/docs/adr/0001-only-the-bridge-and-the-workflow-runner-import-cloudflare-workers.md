# Only the bridge and the Workflow runner import cloudflare:workers

`apps/web` keeps prerendering `/` under Alchemy, whose prerender server runs the SSR bundle in Bun without bindings, where a top-level import of `cloudflare:workers` fails. So only two modules reach `cloudflare:workers`: the bridge in `packages/server`, which reaches it lazily per request, and `workflow.ts`, which imports it at the top because a Workflow class must extend `WorkflowEntrypoint`. Only a Worker's entry imports `workflow.ts`, never a route. The dashboard's Durable Objects (the trading-day object, the day index object and the billing Worker's object) are plain classes rather than `DurableObject` subclasses for the same reason; they need no RPC, and each callback runs through the bridge's result runner, which logs any failure.

The recorded fallback is Alchemy's runtime plugin in `apps/web/vite.config.ts`, for preview only.

Sites:
- `packages/server/src/bridge.ts`
- `packages/server/src/workflow.ts`
- `apps/web/vite.config.ts`
- `apps/dashboard/billing/worker.ts`
- `apps/dashboard/src/server/market-live/day-index-object.ts`
- `apps/dashboard/src/server/market-live/trading-day-object.ts`

Source: apinrdw/kumora#23, apinrdw/kumora#305
