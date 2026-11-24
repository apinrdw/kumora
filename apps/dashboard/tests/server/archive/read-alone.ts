// A part of an admin page's ArchiveDb read, in a batch of its own, as a
// test reads one part without the page around it.
import { Effect } from "effect"

import type { Rows } from "@/server/archive/page-read"
import { type ImportedKind, readRuns } from "@/server/archive/run-import"
import type { Statement } from "@/server/d1"

// A part with no run kinds infers none of their errors or services.
export const readAlone = <A, E2, R2, E1 = never, R1 = never>(part: {
  readonly kinds: ReadonlyArray<ImportedKind<E1, R1>>
  readonly statements: ReadonlyArray<Statement>
  readonly read: (rows: ReadonlyArray<Rows>) => Effect.Effect<A, E2, R2>
}) => Effect.flatMap(readRuns(part.kinds, part.statements), part.read)
