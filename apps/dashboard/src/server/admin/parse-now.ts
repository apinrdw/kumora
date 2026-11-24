// Parse now on an archive's admin page: starts a parse run of one kind
// (../holdings/parse-runs.ts) now, refused while one of that kind is queued
// or running, or while the kind's runs are still importing.
import { Conflict } from "@workspace/server"
import { DateTime, Effect } from "effect"

import { importingAsConflict } from "@/server/admin/archive-access"
import { dailyRunIdAt } from "@/server/archive/run"
import type { ParseRuns } from "@/server/holdings/parse-runs"

export const parseNow = Effect.fnUntraced(function* <Self>(
  runs: ParseRuns<Self>
) {
  const id = yield* dailyRunIdAt(
    "admin",
    DateTime.toEpochMillis(yield* DateTime.now)
  )
  const refused = () =>
    Effect.fail(new Conflict({ message: "A parse run is in progress." }))
  // DuplicateRunId: another start in the same millisecond took the id.
  yield* runs
    .start(id, "admin")
    .pipe(
      Effect.catchTags({ RunInProgress: refused, DuplicateRunId: refused }),
      importingAsConflict
    )
  return { id }
})
