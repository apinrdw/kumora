// One archive run: `plan`, `head`, then one `report:<url>` step per report
// to store, then `summary`. Each step's body is an Effect; the run itself
// only orders the steps, so it holds nothing a Workflow replay could change.
// Spec apinrdw/kumora#303, "The archive run".
import {
  NonRetryable,
  type StepFailed,
  type WorkflowSteps,
} from "@workspace/server"
import { DateTime, Effect, Result, Schema, Stream } from "effect"
import {
  HttpClient,
  type HttpClientError,
  type HttpClientResponse,
} from "effect/http"

import { ArchiveBucket, type BucketError, putJson } from "./bucket.ts"
import {
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
  type ArchiveRunId,
  type ArchiveTrigger,
  runningResult,
} from "./run-result.ts"

export interface ArchiveRun {
  readonly id: ArchiveRunId
  readonly trigger: ArchiveTrigger
  readonly startedAt: Date
}

type StepServices = ArchiveBucket | HttpClient.HttpClient

// A held URL, and the ETags and file hashes its records hold.
const HeldReport = Schema.Struct({
  report: ListedReport,
  etags: Schema.Array(Schema.String),
  sha256s: Schema.Array(Schema.String),
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
  // Whether no record of its URL held these bytes when the run planned.
  newVersion: Schema.Boolean,
})
type ArchivedReport = typeof ArchivedReport.Type

// The record's custom metadata keys, which `plan` reads back.
const SOURCE_URL = "sourceUrl"
const ETAG = "etag"
const SHA256 = "sha256"

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

// The listing, the (URL, ETag) pairs the archive holds, and the run's
// `running` record. runs/latest.json already names the run: its start
// claimed it (start-run.ts).
const plan = Effect.fnUntraced(function* (
  run: ArchiveRun
): Effect.fn.Return<
  Plan,
  ListingUnreadable | NonRetryable | BucketError,
  StepServices
> {
  const listed = yield* fetchListing
  const bucket = yield* ArchiveBucket
  const heldByUrl = new Map<
    string,
    { readonly etags: Array<string>; readonly sha256s: Array<string> }
  >()
  // Decision: one listing of reports/ with custom metadata, as the spec's
  // `plan` step says: ~150 files and their records, growing ~2 a day, held
  // for the step alone. A per-URL lookup would cost a request per listed
  // report. See apinrdw/kumora#303 and #305.
  for (const { customMetadata } of yield* bucket.list(REPORTS_PREFIX)) {
    const url = customMetadata[SOURCE_URL]
    if (url === undefined) continue
    const held = heldByUrl.get(url) ?? { etags: [], sha256s: [] }
    const etag = customMetadata[ETAG]
    if (etag !== undefined) held.etags.push(etag)
    const sha256 = customMetadata[SHA256]
    if (sha256 !== undefined) held.sha256s.push(sha256)
    heldByUrl.set(url, held)
  }
  yield* putJson(yield* runKey(run.id), yield* runningResult(run))
  return {
    fresh: listed.filter((report) => !heldByUrl.has(report.sourceUrl)),
    held: listed.flatMap((report) => {
      const held = heldByUrl.get(report.sourceUrl)
      return held === undefined ? [] : [{ report, ...held }]
    }),
  }
})

// Concurrent HEADs to www.idx.id, kept modest out of courtesy to IDX.
const HEAD_CONCURRENCY = 4

const Checked = Schema.Struct({
  // How many held URLs answered their HEAD.
  checked: Schema.Number,
  // Held URLs whose ETag no record has, with the ETag their HEAD answered.
  changed: Schema.Array(
    Schema.Struct({ report: ListedReport, etag: Schema.String })
  ),
  // Held URLs whose HEAD failed, by source URL.
  unanswered: Schema.Array(Schema.String),
})

// An ETag as compared: `W/"x"` (weak, as a HEAD may answer) and `"x"` are
// the same file.
const comparableEtag = (etag: string) =>
  Effect.sync(() => etag.replace(/^W\//, "").replace(/^"(.*)"$/, "$1"))

// A HEAD to every held URL. A response with no ETag can't show a change, so
// its URL counts as unchanged. A failed HEAD doesn't fail the step: its URL
// is recorded, and the next run checks it again.
const head = Effect.fnUntraced(function* (
  held: Plan["held"]
): Effect.fn.Return<typeof Checked.Type, never, StepServices> {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const answers = yield* Effect.forEach(
    held,
    ({ report, etags }) =>
      client.head(report.fetchUrl).pipe(
        Effect.flatMap(
          Effect.fnUntraced(function* (response) {
            const etag = response.headers["etag"]
            if (etag === undefined) return { report, etag, changed: false }
            const seen = yield* Effect.forEach(etags, comparableEtag)
            return {
              report,
              etag,
              changed: !seen.includes(yield* comparableEtag(etag)),
            }
          })
        ),
        Effect.mapError(() => report.sourceUrl),
        Effect.result
      ),
    { concurrency: HEAD_CONCURRENCY }
  )
  const answered = answers
    .filter(Result.isSuccess)
    .map(({ success }) => success)
  return {
    checked: answered.length,
    changed: answered.flatMap(({ report, etag, changed }) =>
      changed && etag !== undefined ? [{ report, etag }] : []
    ),
    unanswered: answers.filter(Result.isFailure).map(({ failure }) => failure),
  }
})

// The most a report download may be: IDX's files are ~400 KB, and a Worker
// has 128 MB. www.idx.id's GET sends no Content-Length, so the body is
// counted as it streams in.
export const MAX_REPORT_BYTES = 16 * 1024 * 1024

// The body, read until it passes MAX_REPORT_BYTES. A file that big won't
// shrink on a retry, so it fails NonRetryable.
const readCapped = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  url: string
) {
  const read = yield* Stream.runFoldEffect(
    response.stream,
    () => ({ size: 0, chunks: new Array<Uint8Array>() }),
    (acc, chunk) =>
      acc.size + chunk.length > MAX_REPORT_BYTES
        ? Effect.fail(
            new NonRetryable({
              message: `IDX's file at ${url} is over ${MAX_REPORT_BYTES} bytes`,
            })
          )
        : Effect.sync(() => {
            acc.chunks.push(chunk)
            return { size: acc.size + chunk.length, chunks: acc.chunks }
          })
  )
  const bytes = new Uint8Array(read.size)
  let offset = 0
  for (const chunk of read.chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
})

// Downloads one report from www.idx.id and stores it: the .xlsx once per
// hash, then its record, whose presence marks the version complete.
// `headEtag` is what the `head` step saw for a changed held URL. A GET that
// sends no ETag records it instead, so the next HEAD finds it held rather than
// downloading the file on every run. `heldSha256s` are the hashes the URL's
// records held when the run planned.
const archiveReport = Effect.fnUntraced(function* (
  report: ListedReport,
  headEtag: string | null,
  heldSha256s: ReadonlyArray<string>
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
  const bytes = yield* readCapped(response, report.fetchUrl)
  const fetchedAt = yield* nowIso
  const sha256 = yield* sha256Hex(bytes)
  const etag = response.headers["etag"] ?? headEtag
  const bucket = yield* ArchiveBucket
  const xlsxKey = yield* reportKey(report.kind, report.dataDate, sha256)
  if (!(yield* bucket.exists(xlsxKey)))
    yield* bucket.put(xlsxKey, bytes, {
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
        [SHA256]: sha256,
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
    // Decided from the plan, not from the .xlsx being there: a retry of this
    // step finds the .xlsx its first attempt wrote.
    newVersion: !heldSha256s.includes(sha256),
  }
})

const finishedResult = Effect.fnUntraced(function* (run: ArchiveRun) {
  return { ...(yield* runningResult(run)), finishedAt: yield* nowIso }
})

const summary = Effect.fnUntraced(function* (
  run: ArchiveRun,
  checked: typeof Checked.Type,
  archived: ReadonlyArray<ArchivedReport>,
  notStored: ReadonlyArray<string>
) {
  const changedUrls = new Set(
    checked.changed.map(({ report }) => report.sourceUrl)
  )
  const result = ArchiveRunResult.make({
    ...(yield* finishedResult(run)),
    outcome: notStored.length === 0 ? "complete" : "partial",
    reportsAdded: archived.filter(
      ({ sourceUrl }) => !changedUrls.has(sourceUrl)
    ).length,
    // Decision: a changed ETag that serves bytes a record of its URL already
    // holds adds a record but no new version: the file IDX serves didn't
    // change. See apinrdw/kumora#307.
    newVersions: archived.filter(
      ({ sourceUrl, newVersion }) => changedUrls.has(sourceUrl) && newVersion
    ).length,
    reportsChecked: checked.checked,
    notStored,
    other: archived
      .filter(({ kind }) => kind === "other")
      .map(({ sourceUrl, description }) => ({ sourceUrl, description })),
  })
  yield* putJson(yield* runKey(run.id), result)
  return result
})

// `plan` failed, so nothing was stored: the run is failed with its message.
const recordPlanFailure = Effect.fnUntraced(function* (
  run: ArchiveRun,
  error: string
) {
  const result = ArchiveRunResult.make({
    ...(yield* finishedResult(run)),
    outcome: "failed",
    error,
  })
  yield* putJson(yield* runKey(run.id), result)
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
        .do("failed", recordPlanFailure(run, message))
        .pipe(Effect.ignore({ log: "Warn" }))
    )
  )
  const checked = yield* steps.do("head", head(planned.held))
  const heldSha256s = new Map(
    planned.held.map(({ report, sha256s }) => [report.sourceUrl, sha256s])
  )
  const toStore = [
    ...planned.fresh.map((report) => ({ report, etag: null })),
    ...checked.changed,
  ]
  // A report that still fails after its step's retries isn't held at that
  // ETag, so the next run retries it; this one carries on.
  const stored = yield* Effect.forEach(toStore, ({ report, etag }) =>
    steps
      .do(
        `report:${report.sourceUrl}`,
        archiveReport(report, etag, heldSha256s.get(report.sourceUrl) ?? [])
      )
      .pipe(
        Effect.mapError(() => report.sourceUrl),
        Effect.result
      )
  )
  const archived = stored.filter(Result.isSuccess).map(({ success }) => success)
  // A held URL whose HEAD failed may hide a change this run couldn't store.
  const notStored = [
    ...checked.unanswered,
    ...stored.filter(Result.isFailure).map(({ failure }) => failure),
  ]
  return yield* steps.do("summary", summary(run, checked, archived, notStored))
})
