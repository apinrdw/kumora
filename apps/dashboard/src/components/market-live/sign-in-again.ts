import { Effect } from "effect"

import { withRedirect } from "@/lib/redirect"

// A 4401 close or a 401 recorded day answer: a full load of the sign-in page,
// which reads its own session state, and back here after.
export const signInAgain = Effect.gen(function* () {
  const { pathname, search } = window.location
  const href = yield* withRedirect("/sign-in", `${pathname}${search}`)
  window.location.assign(href)
})
