import { useHydrated } from "@tanstack/react-router"

import { KBadge, KButton } from "@/components/k"
import { authClient } from "@/lib/auth-client"
import { dateTime } from "@/lib/format"
import type { SessionRow } from "@/server/auth/account-page"

import {
  AccountSection,
  OutcomeLine,
  useAccountAction,
  type Outcome,
} from "./account-section"

const ended = (error: unknown, message: string): Outcome =>
  error
    ? { _tag: "Failed", message: "Couldn't end the session. Try again." }
    : { _tag: "Done", message }

/**
 * Every signed-in browser of the account, this one first and marked. Ending
 * this one is Sign out, in the user menu.
 */
export function SessionsSection({
  sessions,
  canEnd,
}: {
  sessions: ReadonlyArray<SessionRow>
  canEnd: boolean
}) {
  const hydrated = useHydrated()
  const { pending, outcome, run } = useAccountAction()
  const others = sessions.filter((session) => !session.current).length
  const end = (session: SessionRow) =>
    run(async () => {
      const { error } = await authClient.revokeSession({
        token: session.token,
      })
      return ended(error, `Ended the session on ${session.device}.`)
    })
  const endOthers = () =>
    run(async () => {
      const { error } = await authClient.revokeOtherSessions()
      return ended(error, "Ended every other session.")
    })
  return (
    <AccountSection
      title="Sessions"
      description="The browsers signed in to this account."
    >
      <ul className="flex flex-col divide-y divide-border">
        {sessions.map((session) => (
          <li
            key={session.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                {session.device}
                {session.current && (
                  <KBadge tone="accent" icon={false}>
                    This device
                  </KBadge>
                )}
              </span>
              <span className="num text-xs text-muted-foreground">
                {session.ipAddress ?? "Unknown IP"} · Last active{" "}
                {dateTime(session.lastActive)}
              </span>
            </div>
            {canEnd && !session.current && (
              <KButton
                variant="secondary"
                size="sm"
                disabled={!hydrated || pending}
                onClick={() => void end(session)}
              >
                End
              </KButton>
            )}
          </li>
        ))}
      </ul>
      {canEnd && others > 0 && (
        <KButton
          variant="danger"
          className="self-start"
          disabled={!hydrated}
          loading={pending}
          onClick={() => void endOthers()}
        >
          End all other sessions
        </KButton>
      )}
      <OutcomeLine outcome={outcome} />
    </AccountSection>
  )
}
