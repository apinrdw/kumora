# Server

The bridge every app's server functions run through, server-only, and the loader side that decodes its failures in route loaders.

## Language

**Bridge**:
`runServerEffect`, `runServerEffectResult` and the module around them: the per-isolate runtime, `WorkerEnv`, `WaitUntil`, and the mapping from failures to HTTP. With the Workflow runner, the only code that reaches `cloudflare:workers`.

**Workflow runner**:
`makeWorkflow` in `@workspace/server/workflow`: it builds a Cloudflare Workflow class whose run is an Effect over **Workflow steps**. It reaches `cloudflare:workers` at the top, since the class must extend `WorkflowEntrypoint`, so only a Worker's entry imports it. A step that still fails after the runtime's retries reaches the run as `StepFailed`, which keeps only the step's name and message. A step fails with `NonRetryable` when no retry can fix it, and the runner throws that as `NonRetryableError`.
_Avoid_: Workflow bridge

**Workflow steps**:
`WorkflowSteps`, the steps of one Workflow run as Effects. `do(name, effect)` runs a durable step, whose result must be plain JSON. The Workflow runner provides each step its services; a test runs the steps in-process.

**Result runner**:
`runServerEffectResult`, the runner beside `runServerEffect` for code that answers an HTTP error itself, such as a custom Worker entry. It resolves to a `Result`: the program's value, its HTTP error, or the bare 500 `Response` for any other failure or defect, which it logs. It never throws.

**Per-isolate layer**:
The services built once per Worker isolate and shared by every request. Pure and config services only.

**WorkerEnv**:
The per-request service holding the app's Cloudflare bindings and secrets, typed by the app's stack.
_Avoid_: env, bindings (for the service)

**WaitUntil**:
The per-request service that keeps the isolate alive for work the response doesn't wait on, such as a mail send. Its live layer, `waitUntilLive`, reads `waitUntil` from `cloudflare:workers`.

**WorkerEnv shape**:
The type of WorkerEnv's value, `WorkerEnvShape`: Alchemy's `Cloudflare.InferEnv` of an app's stack, which each app exports (`WebEnv`, `DashboardEnv`) and registers as `Register.env`. Those names follow Alchemy's; "env" is wrong only for the service.

**HTTP error**:
One of the closed set `NotFound`, `BadRequest`, `Forbidden`, `Conflict` and `Unauthorized`, the only failures a server function sends to HTTP. Any other failure is a 500.

**Loader error**:
One of the HTTP errors `NotFound`, `BadRequest`, `Forbidden` and `Conflict` as a route loader receives it: `loadServerFn` in `@workspace/server/loader` decodes a server function's failure back into it. `Unauthorized` reaches the loader as a router redirect, and anything else (a 500, a network failure) is an unexpected error. Unlike the bridge, the loader side runs in the browser too. `runLoader` runs the loader's Effect for the router: a `NotFound` goes to the route's not-found UI, the other three to its error UI.
