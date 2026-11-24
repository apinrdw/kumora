// An admin page's archive metadata in one ArchiveDb batch: each part of the
// page (its last run, recent runs, totals, …) gives its statements and how
// to read their rows, and `readPage` sends every part's statements at once.
// Spec apinrdw/kumora#659, "The page read".
import { Effect } from "effect"

import type { Statement } from "../d1.ts"
import type { ArchiveDb, ArchiveDbError } from "./archive-db.ts"
import { type ImportedKind, readRuns } from "./run-import.ts"

export type Rows = ReadonlyArray<Record<string, unknown>>

export interface PageRead<A, E = never, R = never> {
  // The run kinds its statements read, each imported first should ArchiveDb
  // not have imported it (run-import.ts).
  readonly kinds: ReadonlyArray<ImportedKind<E, R>>
  readonly statements: ReadonlyArray<Statement>
  // Its value, from each of its statements' rows, in order. Only a run
  // that says running reads more: its Workflow instance's status.
  readonly read: (rows: ReadonlyArray<Rows>) => Effect.Effect<A, E, R>
}

type AnyRead = PageRead<unknown, unknown, unknown>

type ValueOf<P extends AnyRead> = Effect.Success<ReturnType<P["read"]>>

type ErrorOf<P extends AnyRead> =
  | Effect.Error<ReturnType<P["read"]>>
  | Effect.Error<P["kinds"][number]["importRuns"]>
  | ArchiveDbError

type ServicesOf<P extends AnyRead> =
  | Effect.Services<ReturnType<P["read"]>>
  | Effect.Services<P["kinds"][number]["importRuns"]>
  | ArchiveDb

// Times a part of the page's load (timePart, ../admin/part-timing.ts).
type Timed = (
  part: string
) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

// Every part's value, keyed as `parts` is: their statements in one
// ArchiveDb batch, timed as `archiveDb`, then each part's read, timed by
// its key. Only the first load after a kind's cutover sends more batches.
export const readPage = <const P extends Record<string, AnyRead>>(
  parts: P,
  timed: Timed
) =>
  Effect.gen(function* () {
    const entries = Object.entries(parts)
    const kinds = new Map<string, ImportedKind<unknown, unknown>>()
    for (const [, part] of entries)
      for (const kind of part.kinds)
        kinds.set(`${kind.archive}/${kind.runKind}`, kind)
    const rows = yield* readRuns(
      [...kinds.values()],
      entries.flatMap(([, part]) => part.statements)
    ).pipe(timed("archiveDb"))
    let offset = 0
    const reads = entries.map(([key, part]) => {
      const own = rows.slice(offset, offset + part.statements.length)
      offset += part.statements.length
      return [key, part.read(own).pipe(timed(key))] as const
    })
    return yield* Effect.all(Object.fromEntries(reads), {
      concurrency: "unbounded",
    })
  }) as Effect.Effect<
    { readonly [K in keyof P]: ValueOf<P[K]> },
    ErrorOf<P[keyof P]>,
    ServicesOf<P[keyof P]>
  >

// `part`'s value, read in a batch of its own.
export const readAlone = <P extends AnyRead>(part: P) =>
  Effect.flatMap(
    readRuns(part.kinds, part.statements),
    part.read
  ) as Effect.Effect<ValueOf<P>, ErrorOf<P>, ServicesOf<P>>
