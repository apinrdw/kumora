// Seeds the Test stage's shareholding archive bucket (archive-bucket.ts).
import * as Schema from "effect/Schema"

import { RunMetadata } from "../../dashboard/src/server/shareholding/run-result.ts"
import { putObject } from "./archive-bucket"

const put = (
  key: string,
  body: string,
  contentType: string,
  metadata?: Readonly<Record<string, string>>
) => putObject("ShareholdingArchiveBucket", key, body, contentType, metadata)

const putJson = (key: string, value: unknown) =>
  put(key, JSON.stringify(value), "application/json")

/** An archive run's result, as runs/<id>.json holds it. */
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

/**
 * Stores a report under `reports/<kind>/<data date>/` as an archive run
 * would: `bytes` bytes of file, then its listing record.
 */
export async function seedReport(prefix: string, hash: string, bytes: number) {
  await put(
    `reports/${prefix}/${hash}.xlsx`,
    "x".repeat(bytes),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
  await putJson(`reports/${prefix}/${hash}.20261114T060000000Z.0000.json`, {
    sha256: hash,
  })
}
