import { Effect, Predicate } from "effect"

import { withRedirect } from "@/lib/redirect"

// A 4401 close or a 401 recorded day answer: a full load of the sign-in page,
// which reads its own session state, and back here after.
export const signInAgain = Effect.gen(function* () {
  const { pathname, search } = window.location
  const href = yield* withRedirect("/sign-in", `${pathname}${search}`)
  window.location.assign(href)
})

// A recorded day load run for its effect: a 401 sends the visitor to sign
// in, and any other failure is logged as `what` not loaded.
export const loadedOrSignIn = <A, E, R>(
  load: Effect.Effect<A, E, R>,
  what: string
) =>
  load.pipe(
    Effect.catchIf(
      (error) => Predicate.isTagged(error, "SignInRequired"),
      () => signInAgain
    ),
    Effect.catchCause((cause) => Effect.logWarning(`${what} not loaded`, cause))
  )
