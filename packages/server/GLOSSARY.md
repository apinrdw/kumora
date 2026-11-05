# Server

The bridge every app's server functions run through. Server-only.

## Language

**Bridge**:
`runServerEffect` and the module around it: the per-isolate runtime, `WorkerEnv`, and the mapping from failures to HTTP. The only code that reaches `cloudflare:workers`.

**Per-isolate layer**:
The services built once per Worker isolate and shared by every request. Pure and config services only.

**WorkerEnv**:
The per-request service holding the app's Cloudflare bindings and secrets, typed by the app's stack.
_Avoid_: env, bindings (for the service)

**Env type**:
The shape of WorkerEnv's value: Alchemy's `Cloudflare.InferEnv` of an app's stack, exported as `WebEnv` or `DashboardEnv` and registered as `Register.env`. "Env" is right for this type, after Alchemy's name; it is wrong for the service.

**HTTP error**:
One of the closed set `NotFound`, `BadRequest`, `Forbidden`, `Conflict` and `Unauthorized`, the only failures a server function sends to HTTP. Any other failure is a 500.
