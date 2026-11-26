// Seeds disclosure runs and the disclosure index into the Test stage's
// ArchiveDb, as a start and its run's steps would write them.
import type { DisclosureRunResult } from "../../dashboard/src/server/disclosures/run-result.ts"
import { writeTo } from "./local-d1"
import { seedRunRow } from "./runs"

/** A disclosure run's result, as its ArchiveDb row holds it. */
export type SeededDisclosureRun = typeof DisclosureRunResult.Encoded

/**
 * Writes the run's row and leaves the last run alone, so it can run beside
 * the specs that make their own run the last.
 */
export async function seedDisclosureRun(run: SeededDisclosureRun) {
  seedRunRow("disclosure", "archive", run, { latest: false })
}

/**
 * A disclosure day as a run leaves it, listed after it ended: complete or
 * not, with one disclosure whose Indonesian version lists `stored` stored
 * attachments and `waiting` waiting ones.
 */
export function seedDisclosureDay(
  day: string,
  {
    complete,
    stored,
    waiting,
  }: {
    readonly complete: boolean
    readonly stored: number
    readonly waiting: number
  }
) {
  const at = `${day}T20:00:00.000Z`
  const key = `${day.replaceAll("-", "")}090000-E2E/1`
  writeTo("ArchiveDb", (db) => {
    db.prepare(
      "INSERT OR REPLACE INTO disclosure_day (day, listed_at, complete_at) VALUES (?, ?, ?)"
    ).run(day, at, complete ? at : null)
    db.prepare(
      "INSERT OR REPLACE INTO disclosure_version " +
        "(disclosure_key, language, day, object_key, stored_at) VALUES (?, 'id', ?, ?, ?)"
    ).run(key, day, `disclosures/${encodeURIComponent(key)}/id.json`, at)
    for (let n = 0; n < stored + waiting; n++) {
      const path = `/StaticData/e2e/${n}.pdf`
      db.prepare(
        "INSERT OR REPLACE INTO disclosure_attachment " +
          "(disclosure_key, path, day, object_key, stored_at, bytes) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(
        key,
        path,
        day,
        `disclosures/${encodeURIComponent(key)}/files${path}`,
        n < stored ? at : null,
        n < stored ? 1000 : null
      )
    }
  })
}

/** Writes the run's row as the last run. */
export async function seedLatestDisclosureRun(run: SeededDisclosureRun) {
  seedRunRow("disclosure", "archive", run, { latest: true })
}
