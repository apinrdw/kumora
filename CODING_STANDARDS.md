# Coding standards

Read during review, not implementation. Each rule is a judgement call a reviewer applies to the diff; mechanical rules live in the checks CI runs (`.github/workflows/ci.yml`), and a rule moves there once it can be written as one.

## Shell in package scripts

A pipe in an npm script hides the producer's failure, because `sh` has no `pipefail`. CI fails on a pipe fed by a command outside the allowlist that `scripts/package-scripts.mts` defines. The reviewer's part is the remaining shape: a script that writes to a file or to a remote (`> file`, `secret bulk`, `deploy`) must stop before the write when the step that produced its input failed. The spec can be wrong here too; a prescribed line is still reviewed.

## One definition per shared value

A value that two files must agree on (a hash length, a route path, a header name, a key name) has one definition. The second file imports it, or, when the two cannot share a module (a Worker route and a Node script), each names the other in a comment at the definition so a change to one finds the other.

## Glossary terms are types

A parameter or field that holds a glossary term (an Environment, a Preview) carries a union or branded type from that term's definition, never a bare `string` narrowed by `includes`. Parse external input (argv, JSON, env) into the type at the boundary and trust it inside.

## Bounded memory on a Worker

Code that handles an uploaded file or a whole table on a Worker has a bound that holds at the largest accepted size, and a test at that size. A size check after the body is read is no bound. Three separate review rounds of spec #133 found this class.

## Claims about third-party dashboards

A handoff doc or spec that states what a dashboard shows, offers, or lacks names the date it was observed, in the same sentence or the section's heading. A claim with no date is a guess and is reviewed as one. Prefer a line that can be re-derived (an API call, a CLI command) over one that must be re-observed by hand.

## Server code in Effect

Server functions run as Effect programs through `runServerEffect` in `packages/server`. Three rules lint cannot check:

- **The per-isolate layer does no I/O and cannot fail.** It is built once per isolate, before any request, and workerd pins I/O objects to the request that created them. Pure and config services only; anything that needs I/O is a per-request effect.
- **Only the closed error set crosses to HTTP.** A server function fails with `NotFound`, `BadRequest`, `Forbidden` or `Conflict` to send that status, or with `Unauthorized` to redirect. Every other failure and every defect is logged and answered as a bare 500, so a domain error reaches HTTP only when the code maps it to one of the five.
- **Cloudflare env only through `WorkerEnv`.** Read bindings and secrets from the per-request `WorkerEnv` service, never from a module-level copy. Lint bans `cloudflare:workers` outside the bridge, but not a value passed around from it.

## Effect outside the server

Lint bans `async`, `Promise`, `throw`, `process.exit`, `process.env` and `node:fs`/`node:child_process` in each directory under an Effect override in `.oxlintrc.json`. These rules are the part lint can't check:

- **Every non-component function returns an Effect**, pure helpers included, a private helper inside a `.tsx` file too. The exceptions are React components and hooks, callbacks a third-party library or React calls (Base UI, recharts, Lightweight Charts, an oxlint plugin's `create`, a `useSyncExternalStore` `subscribe`/`getSnapshot`), a function that builds a config object or callback a third party takes as is (Better Auth's `authOptions`, recharts' tooltip `content` from `pointReadout`), the plain methods of a port that adapts a synchronous third-party API (the `Sql` port over Durable Object SQLite), a closure local to a component, an event handler or an effect hook's body, a Layer and the `make` that builds one (it is already an Effect value), and `packages/ui`, which stays shadcn CLI output. A hot-path helper may stay plain when wrapping it costs a measured slowdown: its `Decision:` names the path and the timing with and without Effects (the Stockbit frame reader, the candle arithmetic), and the Effect around its loop stays. An event handler and an effect hook's body are where React hands over to Effect: they run Effects through the client runtime, and so does a helper that is an effect hook's body (it forks through the client runtime or subscribes, and returns the cleanup). Test-only code may use plain functions: fixtures that build a Layer, Stream or literal data, and helpers a test file keeps to itself (an assertion, a lockfile or graph walk). The lint bans still apply to tests.
- **Write `Effect.gen` where `oxc/no-async-await` fires.** Its message is fixed text and can't name the fix. A reusable function is `Effect.fn("name")` or `Effect.fnUntraced`.
- **`Effect.runSync` only for pure synchronous helpers**, such as a formatter called in render or an alchemy callback that must return a value. Anything that does I/O or can fail runs through a runtime: `runScript` in `scripts/`, `runMain` in `packages/deploy`, the client runtime in the browser, `runServerEffect` on the server, and `runLoader` (`@workspace/server/loader`) in a route loader. A loader runs on both the server and the client, so it uses neither the client runtime nor the bridge, and its Effect needs no services. Better Auth calls the dashboard back with fixed Promise signatures, so its callbacks run through `makeCallbackRunner` (`apps/dashboard/src/server/auth/callbacks.ts`), which maps our HttpErrors to Better Auth's `APIError`, and its hooks through `runHook` (`options.ts`), whose Effects fail with `APIError` directly and need no services. Work a request hands to Cloudflare's `waitUntil`, which takes a Promise and outlives the request's fiber, runs with `Effect.runPromiseWith` on the request's context, as the dashboard's `Mailer` does (`apps/dashboard/src/server/auth/mailer.ts`). Market Live's Worker and Durable Object callbacks hand their Effect to `respond` (`apps/dashboard/src/server/market-live/respond.ts`), which turns its failures into HTTP responses.
- **Domain-data props use Schema-derived types and are never decoded.** A prop that carries rows, Day state or freshness is typed with `Schema.Type` of the domain Schema; decode at the boundary that received the data, not in the component. Primitive, DOM and callback props stay plain TypeScript types.
- **Shareable UI state lives in search params, ephemeral state in `useState`/`useReducer`.** Filters, sort, tab and selection are validated with Schema in `validateSearch`; open/closed and input drafts stay local.
- **Live tables use the keyed-store pattern with `React.memo` rows.** The figures live in a keyed store outside React (`@workspace/client`'s Day state store for Day state), and each row is a `React.memo` component that selects its own stock code through `useSyncExternalStore`, so an update re-renders only that row. A table that re-renders on every update, as one sorted by a live figure does, relies on the memo to skip the rows that didn't change; the watchlist's speed test (`apps/dashboard/tests/components/market-live/watchlist-bench.test.tsx`) re-renders the table on every store notification and fails without it. When the route loader has Day state, it is the store's server snapshot; Market Live's loader has none, because the watchlist's codes live in the browser. Either way the source never runs during SSR.
