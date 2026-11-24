// Seeds runs into the Test stage's ArchiveDb, in
// archive-migrations/0002_runs.sql's columns, as a start and its run's steps
// would write them. Each seed marks its run kind imported, so the cutover
// import never reads the bucket's old run records over it.
import { writeTo } from "./local-d1"

interface SeededRunRecord {
  readonly id: string
  readonly trigger: string
  readonly startedAt: string
  readonly outcome: string
}

/**
 * Writes the run's row: as the run its kind's last start claimed when
 * `latest`, else leaving that claim alone, so it can run beside the specs
 * that claim it for their own run.
 */
export function seedRunRow(
  archive: "ksei" | "shareholding",
  runKind: string,
  run: SeededRunRecord,
  { latest }: { readonly latest: boolean }
) {
  writeTo("ArchiveDb", (db) => {
    db.prepare(
      "INSERT OR IGNORE INTO run_import (archive, run_kind) VALUES (?, ?)"
    ).run(archive, runKind)
    if (latest)
      db.prepare(
        "UPDATE run SET latest = NULL WHERE archive = ? AND run_kind = ?"
      ).run(archive, runKind)
    db.prepare(
      "INSERT OR REPLACE INTO run (archive, run_kind, id, trigger, " +
        "started_at, outcome, latest, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      archive,
      runKind,
      run.id,
      run.trigger,
      Date.parse(run.startedAt),
      run.outcome,
      latest ? 1 : null,
      JSON.stringify(run)
    )
  })
}
