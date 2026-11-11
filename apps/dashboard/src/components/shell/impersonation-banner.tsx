import { IconEye } from "@tabler/icons-react"
import { useHydrated, useRouter } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { Effect } from "effect"
import { useState } from "react"

import { authClient } from "@/lib/auth-client"

/** Its height; the shell offsets its sticky header and sidebar by it. */
export const BANNER_HEIGHT = "2.25rem"

const stop = Effect.fnUntraced(function* (
  router: ReturnType<typeof useRouter>,
  setStopping: (stopping: boolean) => void
) {
  yield* Effect.sync(() => setStopping(true))
  const { error } = yield* Effect.promise(() =>
    authClient.admin.stopImpersonating()
  )
  // An impersonation that already ended has no admin session to return to;
  // the gate sends the browser to sign-in.
  yield* Effect.promise(() =>
    error ? router.invalidate() : router.navigate({ to: "/admin/users" })
  )
  yield* Effect.sync(() => setStopping(false))
})

/**
 * Fixed above every page while an admin views as a member. Stop returns to the
 * admin's own session. Better Auth ends the impersonation by itself after 1 h.
 */
export function ImpersonationBanner({ email }: { email: string }) {
  const router = useRouter()
  const hydrated = useHydrated()
  const [stopping, setStopping] = useState(false)
  return (
    <div
      role="status"
      style={{ height: BANNER_HEIGHT }}
      className="bg-warning sticky top-0 z-40 flex items-center justify-center gap-2 px-4 text-[13px] text-black"
    >
      <IconEye aria-hidden className="size-4 shrink-0" />
      <span className="truncate">
        Viewing as <b className="font-semibold">{email}</b>
      </span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={() => clientRuntime.runFork(stop(router, setStopping))}
        disabled={!hydrated || stopping}
        className="font-semibold underline underline-offset-2 disabled:opacity-60"
      >
        Stop
      </button>
    </div>
  )
}
