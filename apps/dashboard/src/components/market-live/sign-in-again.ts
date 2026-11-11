import { Effect } from "effect"

import { withRedirect } from "@/lib/redirect"

// A 4401 close or a 401 recorded day answer: a full load of the sign-in page,
// which reads its own session state, and back here after.
export const signInAgain = Effect.sync(() => {
  const { pathname, search } = window.location
  window.location.assign(withRedirect("/sign-in", `${pathname}${search}`))
})
