// The viewer socket's gate (spec apinrdw/kumora#138, "The custom Worker entry
// and the gate"): the Origin, a session read past the cookie cache, then the
// access policy. A denial fails with the HTTP error the access policy's
// refusal names; the entry answers any of them with a socket it closes with
// 4401, since a browser can't read a refused handshake's status.
import { MarketLivePath } from "@workspace/relay"
import { Forbidden, WorkerEnv } from "@workspace/server"
import { Effect, type DateTime } from "effect"

import { Auth } from "../auth/auth.ts"
import { decide } from "../auth/policy.ts"
import { refusal } from "../auth/refusal.ts"
import { accountOf } from "../auth/session-account.ts"
import { AccountId, SessionId } from "./routes.ts"

// Decision: the gate runs once; the object closes with 4401 at the session's end
// (apps/dashboard/docs/adr/0041-a-viewer-closes-with-4401-once-its-session-ends.md)
interface LiveViewer {
  readonly userId: AccountId
  readonly sessionId: SessionId
  readonly sessionEnd: DateTime.Utc
}

export const gateLiveViewer = Effect.fn("gateLiveViewer")(function* (
  request: Request
) {
  const env = yield* WorkerEnv
  // Another site's page could open the socket with this site's cookies.
  if (request.headers.get("Origin") !== new URL(env.AUTH_BASE_URL).origin)
    return yield* new Forbidden({ message: "Origin" })
  const auth = yield* Auth
  // Past the cookie cache, so a ban or revoke bites at once.
  const session = yield* auth.getSession(request.headers, { fresh: true })
  const decision = yield* decide(
    yield* accountOf(session),
    "market-live.view-live",
    {
      feature: "market-live",
    }
  )
  if (decision._tag === "Deny")
    return yield* refusal(decision.reason, MarketLivePath.live)
  if (session === null) return yield* refusal("sign-in", MarketLivePath.live)
  return {
    userId: AccountId.make(session.user.id),
    sessionId: SessionId.make(session.session.id),
    sessionEnd: session.session.expiresAt,
  } satisfies LiveViewer
})
