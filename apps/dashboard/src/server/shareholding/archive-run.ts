// One archive run: `plan`, `head`, then one `report:<url>` step per report
// to store, then `summary`. Each step's body is an Effect; the run itself
// only orders the steps, so it holds nothing a Workflow replay could change.
// Spec apinrdw/kumora#303, "The archive run".
import {
  NonRetryable,
  type StepFailed,
  type WorkflowSteps,
} from "@workspace/server"
import { DateTime, Effect, Result, Schema } from "effect"
import { HttpClient, type HttpClientError } from "effect/http"

import { ArchiveBucket, type BucketError } from "./bucket.ts"
import {
  LATEST_RUN_KEY,
  REPORTS_PREFIX,
  recordKey,
  reportKey,
  runKey,
  sha256Hex,
} from "./keys.ts"
import {
  fetchListing,
  ListedReport,
  type ListingUnreadable,
} from "./listing.ts"
import {
  ArchiveRunResult,
  type ArchiveTrigger,
  LatestRun,
  runningResult,
} from "./run-result.ts"

export interface ArchiveRun {
  readonly id: string
  readonly trigger: ArchiveTrigger
  readonly startedAt: Date
}

type StepServices = ArchiveBucket | HttpClient.HttpClient

// A held URL and the ETags its records hold.
const HeldReport = Schema.Struct({
  report: ListedReport,
  etags: Schema.Array(Schema.String),
})

const Plan = Schema.Struct({
  // Listed at a URL the archive doesn't hold.
  fresh: Schema.Array(ListedReport),
  // Listed at a URL it holds, for the `head` step to check.
  held: Schema.Array(HeldReport),
})
type Plan = typeof Plan.Type

// What a `report:<url>` step stored. Never the file's bytes: a step's result
// is at most 1 MiB.
const ArchivedReport = Schema.Struct({
  sourceUrl: Schema.String,
  description: Schema.String,
  kind: ListedReport.fields.kind,
  sha256: Schema.String,
  etag: Schema.NullOr(Schema.String),
  recordKey: Schema.String,
  // Whether these bytes were new, so the step wrote an .xlsx.
  newFile: Schema.Boolean,
})
type ArchivedReport = typeof ArchivedReport.Type

// The record's custom metadata keys, which `plan` reads back.
const SOURCE_URL = "sourceUrl"
const ETAG = "etag"

const writeJson = Effect.fnUntraced(function* (key: string, value: unknown) {
  const bucket = yield* ArchiveBucket
  yield* bucket.put(key, JSON.stringify(value), {
    contentType: "application/json",
  })
})

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

// The listing, the (URL, ETag) pairs the archive holds, and the run's
// `running` record.
const plan = Effect.fnUntraced(function* (
  run: ArchiveRun
): Effect.fn.Return<
  Plan,
  ListingUnreadable | NonRetryable | BucketError,
  StepServices
> {
  const listed = yield* fetchListing
  const bucket = yield* ArchiveBucket
  const etagsByUrl = new Map<string, Array<string>>()
  for (const { customMetadata } of yield* bucket.list(REPORTS_PREFIX)) {
    const url = customMetadata[SOURCE_URL]
    if (url === undefined) continue
    const etags = etagsByUrl.get(url) ?? []
    const etag = customMetadata[ETAG]
    if (etag !== undefined) etags.push(etag)
    etagsByUrl.set(url, etags)
  }
  const id = run.id
  yield* writeJson(
    yield* runKey(id),
    yield* runningResult({
      id,
      trigger: run.trigger,
      startedAt: DateTime.formatIso(DateTime.fromDateUnsafe(run.startedAt)),
    })
  )
  yield* writeJson(LATEST_RUN_KEY, LatestRun.make({ id }))
  return {
    fresh: listed.filter((report) => !etagsByUrl.has(report.sourceUrl)),
    held: listed.flatMap((report) => {
      const etags = etagsByUrl.get(report.sourceUrl)
      return etags === undefined ? [] : [{ report, etags }]
    }),
  }
})

// Concurrent HEADs to www.idx.id, kept modest out of courtesy to IDX.
const HEAD_CONCURRENCY = 4

const Checked = Schema.Struct({
  // How many held URLs got a HEAD.
  checked: Schema.Number,
  // Held URLs whose ETag no record has.
  changed: Schema.Array(ListedReport),
})

// A HEAD to every held URL. A response with no ETag can't show a change, so
// its URL counts as unchanged.
const head = Effect.fnUntraced(function* (
  held: Plan["held"]
): Effect.fn.Return<
  typeof Checked.Type,
  HttpClientError.HttpClientError,
  StepServices
> {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const changed = yield* Effect.filter(
    held,
    ({ report, etags }) =>
      Effect.map(client.head(report.fetchUrl), (response) => {
        const etag = response.headers["etag"]
        return etag !== undefined && !etags.includes(etag)
      }),
    { concurrency: HEAD_CONCURRENCY }
  )
  return {
    checked: held.length,
    changed: changed.map(({ report }) => report),
  }
})

// Downloads one report from www.idx.id and stores it: the .xlsx once per
// hash, then its record, whose presence marks the version complete.
const archiveReport = Effect.fnUntraced(function* (
  report: ListedReport
): Effect.fn.Return<
  ArchivedReport,
  HttpClientError.HttpClientError | NonRetryable | BucketError,
  StepServices
> {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const response = yield* client.get(report.fetchUrl).pipe(
    // IDX removed the file: retrying won't bring it back.
    Effect.catchIf(
      ({ reason }) =>
        reason._tag === "StatusCodeError" && reason.response.status === 404,
      () =>
        Effect.fail(
          new NonRetryable({ message: `IDX has no file at ${report.fetchUrl}` })
        )
    )
  )
  const bytes = yield* response.arrayBuffer
  const fetchedAt = yield* nowIso
  const sha256 = yield* sha256Hex(bytes)
  const etag = response.headers["etag"] ?? null
  const bucket = yield* ArchiveBucket
  const xlsxKey = yield* reportKey(report.kind, report.dataDate, sha256)
  const newFile = !(yield* bucket.exists(xlsxKey))
  if (newFile)
    yield* bucket.put(xlsxKey, new Uint8Array(bytes), {
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })
  const key = yield* recordKey(
    report.kind,
    report.dataDate,
    sha256,
    fetchedAt,
    {
      sourceUrl: report.sourceUrl,
      etag,
    }
  )
  yield* bucket.put(
    key,
    JSON.stringify({
      description: report.description,
      rawDescription: report.rawDescription,
      dataDate: report.dataDate,
      kind: report.kind,
      sourceUrl: report.sourceUrl,
      fetchedUrl: report.fetchUrl,
      etag,
      lastModified: response.headers["last-modified"] ?? null,
      fetchedAt,
      sha256,
    }),
    {
      contentType: "application/json",
      customMetadata: {
        [SOURCE_URL]: report.sourceUrl,
        sha256,
        ...(etag === null ? {} : { [ETAG]: etag }),
      },
    }
  )
  return {
    sourceUrl: report.sourceUrl,
    description: report.description,
    kind: report.kind,
    sha256,
    etag,
    recordKey: key,
    newFile,
  }
})

const finishedResult = Effect.fnUntraced(function* (run: ArchiveRun) {
  return {
    ...(yield* runningResult({
      id: run.id,
      trigger: run.trigger,
      startedAt: DateTime.formatIso(DateTime.fromDateUnsafe(run.startedAt)),
    })),
    finishedAt: yield* nowIso,
  }
})

const summary = Effect.fnUntraced(function* (
  run: ArchiveRun,
  checked: typeof Checked.Type,
  archived: ReadonlyArray<ArchivedReport>,
  notStored: ReadonlyArray<string>
) {
  const changedUrls = new Set(checked.changed.map(({ sourceUrl }) => sourceUrl))
  const result = ArchiveRunResult.make({
    ...(yield* finishedResult(run)),
    outcome: notStored.length === 0 ? "complete" : "partial",
    reportsAdded: archived.filter(
      ({ sourceUrl }) => !changedUrls.has(sourceUrl)
    ).length,
    // Decision: a changed ETag that serves bytes the archive already holds
    // adds a record but no new version: the file IDX serves didn't change.
    newVersions: archived.filter(
      ({ sourceUrl, newFile }) => changedUrls.has(sourceUrl) && newFile
    ).length,
    reportsChecked: checked.checked,
    notStored,
    other: archived
      .filter(({ kind }) => kind === "other")
      .map(({ sourceUrl, description }) => ({ sourceUrl, description })),
  })
  yield* writeJson(yield* runKey(run.id), result)
  return result
})

// `plan` failed, so nothing was stored: the run is failed with its message,
// and runs/latest.json points at it even when `plan` never wrote it.
const failed = Effect.fnUntraced(function* (run: ArchiveRun, error: string) {
  const result = ArchiveRunResult.make({
    ...(yield* finishedResult(run)),
    outcome: "failed",
    error,
  })
  yield* writeJson(yield* runKey(run.id), result)
  yield* writeJson(LATEST_RUN_KEY, LatestRun.make({ id: run.id }))
  return result
})

export const archiveRun = Effect.fn("archiveRun")(function* (
  steps: WorkflowSteps<StepServices>,
  run: ArchiveRun
): Effect.fn.Return<ArchiveRunResult, StepFailed> {
  const planned = yield* steps.do("plan", plan(run)).pipe(
    // The run still fails with `plan`'s message, which the Workflow keeps as
    // the instance's error.
    Effect.tapError(({ message }) =>
      steps
        .do("failed", failed(run, message))
        .pipe(Effect.ignore({ log: "Warn" }))
    )
  )
  const checked = yield* steps.do("head", head(planned.held))
  const toStore = [...planned.fresh, ...checked.changed]
  // A report that still fails after its step's retries isn't held at that
  // ETag, so the next run retries it; this one carries on.
  const stored = yield* Effect.forEach(toStore, (report) =>
    steps.do(`report:${report.sourceUrl}`, archiveReport(report)).pipe(
      Effect.mapError(() => report.sourceUrl),
      Effect.result
    )
  )
  const archived = stored.filter(Result.isSuccess).map(({ success }) => success)
  const notStored = stored
    .filter(Result.isFailure)
    .map(({ failure }) => failure)
  return yield* steps.do("summary", summary(run, checked, archived, notStored))
})
