import { Effect } from "effect"

// The header on every 429 the auth routes answer: Better Auth's per-IP limiter
// sends it, and the per-address mail cap (server/auth/callbacks.ts) sends the
// same one, so a form reads both alike. The value is whole seconds.
export const RETRY_AFTER_HEADER = "X-Retry-After"

/** "Too many attempts. Try again in N minutes." for a wait in seconds. */
export const tooManyAttempts = (seconds: number) =>
  Effect.sync(() => {
    const minutes = Number.isFinite(seconds)
      ? Math.max(1, Math.ceil(seconds / 60))
      : 1
    return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`
  })

/**
 * Pass `onError` in an auth client call's fetch options. `messageFor(error,
 * fallback)` then says how long to wait when the call was refused with 429,
 * and `fallback` for any other refusal.
 */
export const retryAfter = () =>
  Effect.sync(() => {
    let seconds = Number.NaN
    return {
      onError: ({ response }: { response: Response }) => {
        seconds = Number(response.headers.get(RETRY_AFTER_HEADER))
      },
      messageFor: (error: { readonly status: number }, fallback: string) =>
        error.status === 429
          ? tooManyAttempts(seconds)
          : Effect.succeed(fallback),
    }
  })
