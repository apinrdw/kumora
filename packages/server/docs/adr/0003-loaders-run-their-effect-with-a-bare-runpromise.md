# Loaders run their Effect with a bare runPromise

A route loader runs both during SSR and in the browser. Neither existing runner fits both: the client runtime is browser only and `runServerEffect` is Worker only. So loaders run their Effect with a bare `runPromise` and no services.

Sites:
- `packages/server/src/loader.ts`

Source: apinrdw/kumora#132
