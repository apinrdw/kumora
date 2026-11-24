// The run rows in ArchiveDb (archive-migrations/0002_runs.sql): one row per
// run of either archive, with the whole run record as JSON beside the
// columns its reads filter and sort on. The statements here read one kind's
// rows, so an admin page can put several in one ArchiveDb batch
// (`readPage`, page-read.ts).
import { Effect, Option, Schema } from "effect"

import type { Statement } from "../d1.ts"
import { ArchiveDb } from "./archive-db.ts"
import type { ArchiveSource, RunBase, RunSummaryBase } from "./run.ts"

// The archive and run kind whose rows a statement reads.
export type RunKind = Pick<
  ArchiveSource<string, RunSummaryBase, RunBase>,
  "archive" | "runKind"
>

const OF_KIND = "archive = ? AND run_kind = ?"

const kindParams = (kind: RunKind) => [kind.archive, kind.runKind] as const

// The run the kind's last start claimed: no row before any run.
export const lastRunStatement = (kind: RunKind): Statement => ({
  sql: `SELECT record FROM run WHERE ${OF_KIND} AND latest = 1`,
  params: kindParams(kind),
})

// The runs started at `sinceMs` or later, newest first.
export const recentRunsStatement = (
  kind: RunKind,
  sinceMs: number
): Statement => ({
  sql:
    `SELECT record FROM run WHERE ${OF_KIND} AND started_at >= ? ` +
    "ORDER BY started_at DESC, id DESC",
  params: [...kindParams(kind), sinceMs],
})

// A page of `trigger`'s runs, newest first.
export const triggerRunsStatement = (
  kind: RunKind,
  trigger: string,
  page: { readonly offset: number; readonly limit: number }
): Statement => ({
  sql:
    `SELECT record FROM run WHERE ${OF_KIND} AND trigger = ? ` +
    "ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?",
  params: [...kindParams(kind), trigger, page.limit, page.offset],
})

// The run with `id`: no row while it has none.
export const runStatement = (kind: RunKind, id: string): Statement => ({
  sql: `SELECT record FROM run WHERE ${OF_KIND} AND id = ?`,
  params: [...kindParams(kind), id],
})

// The column values of `record`'s row, in RUN_COLUMNS' order.
export const runRow = (record: RunBase) =>
  [
    record.id,
    record.trigger,
    Date.parse(record.startedAt),
    record.outcome,
    JSON.stringify(record),
  ] as const

export const RUN_COLUMNS = "id, trigger, started_at, outcome, record"

// Writes `record` as its run's row, the claim it holds kept. Only a start
// inserts a run's row; this rewrites it as the run goes on.
export const writeRunRow = Effect.fnUntraced(function* (
  kind: RunKind,
  record: RunBase
) {
  yield* (yield* ArchiveDb).batch([
    {
      sql:
        `INSERT INTO run (archive, run_kind, ${RUN_COLUMNS}) ` +
        "VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (archive, run_kind, id) DO UPDATE SET " +
        "trigger = excluded.trigger, started_at = excluded.started_at, " +
        "outcome = excluded.outcome, record = excluded.record",
      params: [...kindParams(kind), ...runRow(record)],
    },
  ])
})

const recordOf = (row: Record<string, unknown>) => row["record"]

// Each row's record, decoded with today's `schema`. A record that no longer
// decodes is passed over.
export const decodeRuns = <A>(
  schema: Schema.Codec<A, unknown>,
  rows: ReadonlyArray<Record<string, unknown>>
) =>
  Effect.sync(() => {
    const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema))
    return rows.flatMap((row) => Option.toArray(decode(recordOf(row))))
  })

// The one row's record, decoded with today's `schema`: undefined with no
// row.
export const decodeRun = <A>(
  schema: Schema.Codec<A, unknown>,
  rows: ReadonlyArray<Record<string, unknown>>
) =>
  rows[0] === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
        recordOf(rows[0])
      )
