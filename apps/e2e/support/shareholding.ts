// Seeds the Test stage's shareholding archive bucket (archive-bucket.ts), and
// the report index in its ArchiveDb, as an archive run would.
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"

import { sha256Hex } from "../../dashboard/src/server/archive/hash.ts"
import { recordName } from "../../dashboard/src/server/archive/record-key.ts"
import { RunMetadata } from "../../dashboard/src/server/shareholding/run-result.ts"
import { putObject } from "./archive-bucket"
import { seedSizedReport, storeIndexedReport } from "./report-index"

const put = (
  key: string,
  body: string | Uint8Array<ArrayBuffer>,
  contentType: string,
  metadata?: Readonly<Record<string, string>>
) => putObject("ShareholdingArchiveBucket", key, body, contentType, metadata)

const putJson = (key: string, value: unknown) =>
  put(key, JSON.stringify(value), "application/json")

/**
 * An archive run's result, as runs/<id>.json holds it. Records written while
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
 * Writes the run's record and leaves runs/latest.json alone, so it can run
 * beside the specs that point it at their own run.
 */
export async function seedRun(run: SeededRun) {
  await put(
    `runs/${run.id}.json`,
    JSON.stringify(run),
    "application/json",
    Schema.encodeUnknownSync(RunMetadata)({ run })
  )
}

/** Writes the run's record and points runs/latest.json at it. */
export async function seedLatestRun(run: SeededRun) {
  await seedRun(run)
  await putJson("runs/latest.json", { id: run.id })
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
 * record whose key the kind's parse run reads.
 */
export async function seedReportFixture(
  kind: "investor-classification" | "investor-type" | "above-1",
  filename: string,
  dataDate: string
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
          FIXTURE_FETCHED_AT,
          `https://www.idx.co.id/Media/${filename}\n`
        )}`,
      }
    })
  )
  await storeIndexedReport("shareholding", {
    kind,
    reportDate: dataDate,
    sha256: keys.sha256,
    fetchedAt: FIXTURE_FETCHED_AT,
    fileKey: keys.report,
    file: bytes,
    contentType: XLSX,
    recordKey: keys.record,
    record: JSON.stringify({ dataDate, sha256: keys.sha256 }),
  })
}
