// Seeds the Test stage's KSEI archive bucket (archive-bucket.ts), and the
// report index in its ArchiveDb, as a KSEI archive run would.
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"

import { sha256Hex } from "../../dashboard/src/server/archive/hash.ts"
import { recordKey, reportKey } from "../../dashboard/src/server/ksei/keys.ts"

import type { KseiRunResult } from "../../dashboard/src/server/ksei/run-result.ts"
import { KseiRunMetadata } from "../../dashboard/src/server/ksei/run-result.ts"
import { putObject } from "./archive-bucket"
import { seedSizedReport, storeIndexedReport } from "./report-index"

const put = (
  key: string,
  body: string | Uint8Array<ArrayBuffer>,
  contentType: string,
  metadata?: Readonly<Record<string, string>>
) => putObject("KseiArchiveBucket", key, body, contentType, metadata)

/** A KSEI archive run's result, as runs/<id>.json holds it. */
export type SeededKseiRun = typeof KseiRunResult.Encoded

/**
 * Writes the run's record and leaves runs/latest.json alone, so it can run
 * beside the specs that point it at their own run.
 */
export async function seedKseiRun(run: SeededKseiRun) {
  await put(
    `runs/${run.id}.json`,
    JSON.stringify(run),
    "application/json",
    Schema.encodeUnknownSync(KseiRunMetadata)({ run })
  )
}

/** Writes the run's record and points runs/latest.json at it. */
export async function seedLatestKseiRun(run: SeededKseiRun) {
  await seedKseiRun(run)
  await put(
    "runs/latest.json",
    JSON.stringify({ id: run.id }),
    "application/json"
  )
}

// When the KSEI seeds' records were fetched, as their keys say.
const FETCHED_AT = "2026-11-14T03:00:00.000Z"

/**
 * Stores a KSEI report under `reports/<kind>/<period end>/` as a run would:
 * `bytes` bytes of zip, then its record.
 */
export async function seedKseiReport(
  prefix: string,
  hash: string,
  bytes: number
) {
  await seedSizedReport("ksei", {
    prefix,
    hash,
    bytes,
    extension: "zip",
    contentType: "application/zip",
    fetchedAt: FETCHED_AT,
  })
}

/**
 * Stores one of the dashboard's trimmed Kepemilikan Efek fixtures
 * (apps/dashboard/tests/server/ksei/fixtures/), such as
 * `BalanceposEfek20261030.zip`, as a KSEI archive run would: the zip under
 * its SHA-256, then a record whose key the KSEI parse run reads.
 */
export async function seedKseiHoldingsFixture(filename: string) {
  const bytes = new Uint8Array(
    readFileSync(
      new URL(
        `../../dashboard/tests/server/ksei/fixtures/${filename}`,
        import.meta.url
      )
    )
  )
  const [, year, month, day] = /(\d{4})(\d{2})(\d{2})/.exec(filename) ?? []
  const periodEnd = `${year}-${month}-${day}`
  const keys = await Effect.runPromise(
    Effect.gen(function* () {
      const sha256 = yield* sha256Hex(bytes)
      return {
        sha256,
        report: yield* reportKey("securities-holdings", periodEnd, sha256),
        record: yield* recordKey(
          "securities-holdings",
          periodEnd,
          sha256,
          FETCHED_AT,
          { filename, etag: null }
        ),
      }
    })
  )
  await storeIndexedReport("ksei", {
    kind: "securities-holdings",
    reportDate: periodEnd,
    sha256: keys.sha256,
    fetchedAt: FETCHED_AT,
    fileKey: keys.report,
    file: bytes,
    contentType: "application/zip",
    recordKey: keys.record,
    record: JSON.stringify({ filename, sha256: keys.sha256 }),
  })
}
