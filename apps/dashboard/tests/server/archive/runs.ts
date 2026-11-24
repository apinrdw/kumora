// What an archive's runs read and write in tests: its bucket (for the
// cutover import), its Workflow and ArchiveDb in one layer, and the run rows
// a test seeds or checks, by archive and run kind.
import { Layer } from "effect"

import type { RunBase } from "@/server/archive/run"

import { fakeWorkflow } from "./fake-workflow.ts"
import { memoryArchiveDb, type MemoryArchiveDb } from "./memory-archive-db.ts"
import { memoryBucket } from "./memory-bucket.ts"

export interface RunKind {
  readonly archive: "ksei" | "shareholding"
  readonly runKind: string
}

export const SHAREHOLDING_ARCHIVE: RunKind = {
  archive: "shareholding",
  runKind: "archive",
}
export const KSEI_ARCHIVE: RunKind = { archive: "ksei", runKind: "archive" }
export const KSEI_PARSE: RunKind = {
  archive: "ksei",
  runKind: "parse-securities-holdings",
}
export const shareholdingParse = (kind: string): RunKind => ({
  archive: "shareholding",
  runKind: `parse-${kind}`,
})

// One archive's bucket and Workflow, with `db` as its ArchiveDb, which both
// archives share on a stage.
export const runStores = (db: MemoryArchiveDb = memoryArchiveDb()) => {
  const bucket = memoryBucket()
  const workflow = fakeWorkflow()
  return {
    bucket,
    workflow,
    db,
    layer: Layer.mergeAll(bucket.layer, workflow.layer, db.layer),
  }
}

// Seeds `record` as a run of `kind`, as the one its last start claimed when
// `latest`, and marks the kind imported, as on a stage past the cutover.
export const seedRun = (
  db: MemoryArchiveDb,
  kind: RunKind,
  record: RunBase,
  { latest = false }: { readonly latest?: boolean } = {}
) => {
  markImported(db, kind)
  if (latest)
    db.database
      .prepare(
        "UPDATE run SET latest = NULL WHERE archive = ? AND run_kind = ?"
      )
      .run(kind.archive, kind.runKind)
  db.database
    .prepare(
      "INSERT OR REPLACE INTO run (archive, run_kind, id, trigger, started_at, outcome, latest, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      kind.archive,
      kind.runKind,
      record.id,
      record.trigger,
      Date.parse(record.startedAt),
      record.outcome,
      latest ? 1 : null,
      JSON.stringify(record)
    )
}

const markImported = (db: MemoryArchiveDb, kind: RunKind) =>
  db.database
    .prepare(
      "INSERT OR IGNORE INTO run_import (archive, run_kind) VALUES (?, ?)"
    )
    .run(kind.archive, kind.runKind)

// The record of `kind`'s run `id`, parsed: undefined without a row.
export const storedRun = (
  db: MemoryArchiveDb,
  kind: RunKind,
  id: string
): Record<string, unknown> | undefined => {
  const row = db.database
    .prepare(
      "SELECT record FROM run WHERE archive = ? AND run_kind = ? AND id = ?"
    )
    .get(kind.archive, kind.runKind, id) as { record: string } | undefined
  return row === undefined ? undefined : JSON.parse(row.record)
}

// The id of `kind`'s run its last start claimed.
export const latestRunId = (db: MemoryArchiveDb, kind: RunKind) =>
  (
    db.database
      .prepare(
        "SELECT id FROM run WHERE archive = ? AND run_kind = ? AND latest = 1"
      )
      .get(kind.archive, kind.runKind) as { id: string } | undefined
  )?.id

const databases = new WeakMap<object, MemoryArchiveDb>()

// The ArchiveDb that goes with `bucket`, one per bucket, for tests that run
// an archive's steps against a bucket and read its runs back.
export const archiveDbOf = (bucket: object) => {
  const known = databases.get(bucket)
  if (known !== undefined) return known
  const made = memoryArchiveDb()
  databases.set(bucket, made)
  return made
}
