// Who may see an archive's admin page and start its runs: an admin, read past
// the cookie cache. Anyone else gets the refusal for `path`.
import { Conflict } from "@workspace/server"
import { Effect } from "effect"

import type { RunsImporting } from "@/server/archive/run-import"
import { Auth } from "@/server/auth/auth"
import { decide, type Action } from "@/server/auth/policy"
import { refusal } from "@/server/auth/refusal"
import { accountOf } from "@/server/auth/session-account"

export const authorizeArchive = Effect.fnUntraced(function* (
  headers: Headers,
  action: Extract<
    Action,
    | `admin.${string}-archive`
    | `admin.run-${string}-parse`
    | "admin.run-sector-sync"
  >,
  path: string
) {
  const auth = yield* Auth
  // Admin server functions read past the cookie cache.
  const session = yield* auth.getSession(headers, { fresh: true })
  const decision = yield* decide(yield* accountOf(session), action, {
    feature: "admin",
  })
  if (decision._tag === "Deny") return yield* refusal(decision.reason, path)
})

// A page read or a start whose runs are still importing from R2
// (RunsImporting, ../archive/run-import.ts) answers a Conflict that says so.
// A page then never shows some of its runs as all of them, and a start
// claims nothing. Each try imports more, until one finishes the import.
// Decision: ArchiveDb is the source of truth for runs
// (apps/dashboard/docs/adr/0128-archivedb-is-the-source-of-truth-for-runs.md)
export const importingAsConflict = <A, E, R>(
  self: Effect.Effect<A, E | RunsImporting, R>
) =>
  Effect.catchTag(self, "RunsImporting", () =>
    Effect.fail(
      new Conflict({
        message:
          "This archive's runs are still being copied into ArchiveDb. Try again to continue.",
      })
    )
  )
