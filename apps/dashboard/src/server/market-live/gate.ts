// The viewer socket's gate (spec apinrdw/kumora#138, "The custom Worker entry
// and the gate"): the Origin, a session read past the cookie cache, then the
// access policy. Any denial is `None`; the entry answers it with a socket it
// closes with 4401, since a browser can't read a refused handshake's status.
import { WorkerEnv } from "@workspace/server"
import { Effect, Option } from "effect"

import { Auth } from "../auth/auth.ts"
import { decide } from "../auth/policy.ts"
import { accountOf } from "../auth/session-account.ts"

interface LiveViewer {
  readonly userId: string
  readonly sessionId: string
}

export const gateLiveViewer = Effect.fn("gateLiveViewer")(function* (
  request: Request
) {
  const env = yield* WorkerEnv
  // Another site's page could open the socket with this site's cookies.
  if (request.headers.get("Origin") !== new URL(env.AUTH_BASE_URL).origin)
    return Option.none<LiveViewer>()
  const auth = yield* Auth
  // Past the cookie cache, so a ban or revoke bites at once.
  const session = yield* auth.getSession(request.headers, { fresh: true })
  const decision = decide(accountOf(session), "market-live.view-live", {
    feature: "market-live",
  })
  if (decision._tag === "Deny" || session === null)
    return Option.none<LiveViewer>()
  return Option.some<LiveViewer>({
    userId: session.user.id,
    sessionId: session.session.id,
  })
})
