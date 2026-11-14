// Seeds the Test stage's KSEI archive bucket (archive-bucket.ts).
import * as Schema from "effect/Schema"

import type { KseiRunResult } from "../../dashboard/src/server/ksei/run-result.ts"
import { KseiRunMetadata } from "../../dashboard/src/server/ksei/run-result.ts"
import { putObject } from "./archive-bucket"

const put = (
  key: string,
  body: string,
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

/**
 * Stores a KSEI report under `reports/<kind>/<period end>/` as a run would:
 * `bytes` bytes of zip, then its record.
 */
export async function seedKseiReport(
  prefix: string,
  hash: string,
  bytes: number
) {
  await put(
    `reports/${prefix}/${hash}.zip`,
    "x".repeat(bytes),
    "application/zip"
  )
  await put(
    `reports/${prefix}/${hash}.20261114T030000000Z.0000.json`,
    JSON.stringify({ sha256: hash }),
    "application/json"
  )
}
