// Seeds the Test stage's shareholding archive bucket (archive-bucket.ts), and
// in its ArchiveDb the report index, as an archive run would, and its runs
// (runs.ts).
import * as Effect from "effect/Effect"
import { readFileSync } from "node:fs"

import { sha256Hex } from "../../dashboard/src/server/archive/hash.ts"
import { recordName } from "../../dashboard/src/server/archive/record-key.ts"
import { seedSizedReport, storeIndexedReport } from "./report-index"
import { seedRunRow } from "./runs"

/**
 * An archive run's result, as its ArchiveDb row holds it. Records written while
 * archive runs also parsed hold months parsed and parse failures.
 */
export interface SeededRun {
  readonly id: string
  readonly trigger: "cron" | "admin"
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly outcome: "running" | "complete" | "partial" | "failed"
  readonly reportsAdded: number
  readonly newVersions: number
  readonly reportsChecked: number
  readonly notStored: ReadonlyArray<string>
  readonly monthsParsed?: number
  readonly parseFailures?: ReadonlyArray<{
    readonly date: string
    readonly message: string
  }>
  readonly other: ReadonlyArray<{
    readonly sourceUrl: string
    readonly description: string
  }>
  readonly error: string | null
}

/**
 * Writes the run's row and leaves the last run alone, so it can run beside
 * the specs that make their own run the last.
 */
export async function seedRun(run: SeededRun) {
  seedRunRow("shareholding", "archive", run, { latest: false })
}

/** Writes the run's row as the last run. */
export async function seedLatestRun(run: SeededRun) {
  seedRunRow("shareholding", "archive", run, { latest: true })
}

// The spreadsheet type the archive stores its files as.
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/**
 * Stores a report under `reports/<kind>/<data date>/` as an archive run
 * would: `bytes` bytes of file, then its listing record.
 */
export async function seedReport(prefix: string, hash: string, bytes: number) {
  await seedSizedReport("shareholding", {
    prefix,
    hash,
    bytes,
    extension: "xlsx",
    contentType: XLSX,
    fetchedAt: "2026-11-14T06:00:00.000Z",
  })
}

// When seedReportFixture's records were fetched, as their keys say.
const FIXTURE_FETCHED_AT = "2026-11-14T13:00:00.000Z"

/**
 * Stores one of the dashboard's trimmed report fixtures
 * (apps/dashboard/tests/server/shareholding/fixtures/), such as
 * `classification-2026-03-31.xlsx` of kind `investor-classification`, under
 * `dataDate` as an archive run would: the .xlsx under its SHA-256, then a
 * record whose key the kind's parse run reads. A later `fetchedAt` makes it
 * the date's newest version over one seeded before.
 */
export async function seedReportFixture(
  kind: "investor-classification" | "investor-type" | "above-1" | "above-5",
  filename: string,
  dataDate: string,
  fetchedAt = FIXTURE_FETCHED_AT
) {
  const bytes = new Uint8Array(
    readFileSync(
      new URL(
        `../../dashboard/tests/server/shareholding/fixtures/${filename}`,
        import.meta.url
      )
    )
  )
  // The keys shareholding/keys.ts writes, which can't be loaded here: its
  // report kinds come from a module that needs the Workers types.
  const prefix = `reports/${kind}/`
  const keys = await Effect.runPromise(
    Effect.gen(function* () {
      const sha256 = yield* sha256Hex(bytes)
      return {
        sha256,
        report: `${prefix}${dataDate}/${sha256}.xlsx`,
        record: `${prefix}${yield* recordName(
          dataDate,
          sha256,
          fetchedAt,
          `https://www.idx.co.id/Media/${filename}\n`
        )}`,
      }
    })
  )
  await storeIndexedReport("shareholding", {
    kind,
    reportDate: dataDate,
    sha256: keys.sha256,
    fetchedAt,
    fileKey: keys.report,
    file: bytes,
    contentType: XLSX,
    recordKey: keys.record,
    record: JSON.stringify({ dataDate, sha256: keys.sha256 }),
  })
}
