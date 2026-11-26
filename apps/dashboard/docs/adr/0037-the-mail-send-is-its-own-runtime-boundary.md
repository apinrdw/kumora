# The mail send is its own runtime boundary

An auth mail's send outlives the request's fiber, and Cloudflare's `waitUntil` keeps the isolate alive only for a Promise. So the send is its own runtime boundary: it runs with `runPromiseWith` on the request's context. CODING_STANDARDS.md lists it among the runtimes.

Sites:

- `apps/dashboard/src/server/auth/mailer.ts`

Source: none
