// An admin page's archive metadata in one ArchiveDb batch: each part of the
// page (its last run, recent runs, totals, …) gives its statements and how
// to read their rows, and `readPage` sends every part's statements at once.
// Spec apinrdw/kumora#659, "The page read". `allReads`, `bothReads` and
// `mapRead` are plain functions, not Effects, as reportIndexOf
// (report-index.ts) is: each archive combines its parts once at module
// load, and they only return a part, whose `read` is the Effect.
import { Effect } from "effect"

import type { Statement } from "../d1.ts"
import type { ArchiveDb, ArchiveDbError } from "./archive-db.ts"
import {
  type ImportedKind,
  readRuns,
  type RunsImporting,
} from "./run-import.ts"

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
  | RunsImporting

type ServicesOf<P extends AnyRead> =
  | Effect.Services<ReturnType<P["read"]>>
  | Effect.Services<P["kinds"][number]["importRuns"]>
  | ArchiveDb

// Times a part of the page's load (timePart, ../admin/part-timing.ts).
type Timed = (
  part: string
) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

// One part of `parts`, whose value is each part's, in order, read at once.
export const allReads = <A, E, R>(
  parts: ReadonlyArray<PageRead<A, E, R>>
): PageRead<ReadonlyArray<A>, E, R> => ({
  kinds: parts.flatMap((part) => part.kinds),
  statements: parts.flatMap((part) => part.statements),
  read: (rows) =>
    Effect.forEach(
      parts,
      (part, index) => {
        const offset = parts
          .slice(0, index)
          .reduce((sum, { statements }) => sum + statements.length, 0)
        return part.read(rows.slice(offset, offset + part.statements.length))
      },
      { concurrency: "unbounded" }
    ),
})

// One part of `first` and `second`, whose value is both of theirs.
export const bothReads = <A, B, E1, R1, E2, R2>(
  first: PageRead<A, E1, R1>,
  second: PageRead<B, E2, R2>
): PageRead<readonly [A, B], E1 | E2, R1 | R2> => ({
  kinds: [...first.kinds, ...second.kinds],
  statements: [...first.statements, ...second.statements],
  read: (rows) =>
    Effect.all([
      first.read(rows.slice(0, first.statements.length)),
      second.read(rows.slice(first.statements.length)),
    ]),
})

// `part`, its value turned by `f`.
export const mapRead = <A, B, E1, R1, E2, R2>(
  part: PageRead<A, E1, R1>,
  f: (value: A) => Effect.Effect<B, E2, R2>
): PageRead<B, E1 | E2, R1 | R2> => ({
  ...part,
  read: (rows) => Effect.flatMap(part.read(rows), f),
})

// Every part's value, keyed as `parts` is: their statements in one
// ArchiveDb batch, timed as `archiveDb`, then each part's read, timed by
// its key. Only the first load after a kind's cutover sends more batches,
// and fails with RunsImporting while its import is unfinished.
export const readPage = <const P extends Record<string, AnyRead>>(
  parts: P,
  timed: Timed
) =>
  Effect.gen(function* () {
    const entries = Object.entries(parts)
    const page = allReads(
      entries.map(([key, part]) => ({
        ...part,
        read: (rows: ReadonlyArray<Rows>) => part.read(rows).pipe(timed(key)),
      }))
    )
    const rows = yield* readRuns(page.kinds, page.statements).pipe(
      timed("archiveDb")
    )
    const values = yield* page.read(rows)
    // Object.fromEntries keeps no key's own type, so the page's value is
    // typed from `parts` below.
    return Object.fromEntries(
      entries.map(([key], index) => [key, values[index]])
    )
  }) as Effect.Effect<
    { readonly [K in keyof P]: ValueOf<P[K]> },
    ErrorOf<P[keyof P]>,
    ServicesOf<P[keyof P]>
  >
