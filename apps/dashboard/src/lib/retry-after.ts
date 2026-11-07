// The header on every 429 the auth routes answer: Better Auth's per-IP limiter
// sends it, and the per-address mail cap (server/auth/callbacks.ts) sends the
// same one, so a form reads both alike. The value is whole seconds.
export const RETRY_AFTER_HEADER = "X-Retry-After"
