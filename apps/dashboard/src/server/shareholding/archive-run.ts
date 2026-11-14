// One archive run: `plan`, `head`, then one `report:` step per report to
// store, then `summary`. Each step's body is an Effect; the run itself
// only orders the steps, so it holds nothing a Workflow replay could change.
// Spec apinrdw/kumora#303, "The archive run".
import {
  jsonBytes,
  NonRetryable,
  type StepFailed,
  type WorkflowSteps,
} from "@workspace/server"
import { DateTime, Effect, Result, Schema } from "effect"
import { HttpClient, type HttpClientError } from "effect/http"

import { ArchiveBucket, type BucketError, putJson } from "./bucket.ts"
import { readCapped } from "./capped-body.ts"
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
  MAX_ETAG_BYTES,
} from "./listing.ts"
import {
  ArchiveRunResult,
  type ArchiveRunId,
  type ArchiveTrigger,
  MAX_RUN_ERROR_LENGTH,
  runningResult,
} from "./run-result.ts"

export interface ArchiveRun {
  readonly id: ArchiveRunId
  readonly trigger: ArchiveTrigger
  readonly startedAt: Date
}

type StepServices = ArchiveBucket | HttpClient.HttpClient

// Each step result holds at most one ListedReport, or less, per listed
// report, which MAX_LISTED_REPORTS (listing.ts) bounds. The ETags and hashes
// a URL's records hold grow with every record, so each step that needs them
// lists reports/ itself instead of receiving them.
const Plan = Schema.Struct({
  // Listed at a URL the archive doesn't hold.
  fresh: Schema.Array(ListedReport),
  // Listed at a URL it holds, for the `head` step to check.
  held: Schema.Array(ListedReport),
})
type Plan = typeof Plan.Type

// What a `report:` step stored. Never the file's bytes: a step's result is
// at most 1 MiB.
const ArchivedReport = Schema.Struct({
  sourceUrl: Schema.String,
  description: Schema.String,
  kind: ListedReport.fields.kind,
  sha256: Schema.String,
  etag: Schema.NullOr(Schema.String),
  recordKey: Schema.String,
})
type ArchivedReport = typeof ArchivedReport.Type

// The record's custom metadata keys, which a run reads back. RUN names the
// run that wrote it, so `summary` can tell its own records from earlier ones.
const SOURCE_URL = "sourceUrl"
const ETAG = "etag"
const SHA256 = "sha256"
const RUN = "run"

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

interface HeldRecords {
  readonly etags: Array<string>
  readonly sha256s: Array<string>
}

// The ETags and hashes the records of each held URL hold, leaving out those
// `run` wrote.
// Decision: `plan`, `head` and `summary` each list reports/ with custom
// metadata, not `plan` alone as the spec says: carried between steps, it
// would outgrow a step result. ~150 files and records on 2026-11-14, ~50
// more a month. A per-URL lookup costs a request per listed report. See
// apinrdw/kumora#303 and #305.
const heldRecords = Effect.fnUntraced(function* (run?: ArchiveRunId) {
  const byUrl = new Map<string, HeldRecords>()
  for (const { customMetadata } of yield* (yield* ArchiveBucket).list(
    REPORTS_PREFIX
  )) {
    const url = customMetadata[SOURCE_URL]
    if (url === undefined || (run !== undefined && customMetadata[RUN] === run))
      continue
    const held = byUrl.get(url) ?? { etags: [], sha256s: [] }
    const etag = customMetadata[ETAG]
    if (etag !== undefined) held.etags.push(etag)
    const sha256 = customMetadata[SHA256]
    if (sha256 !== undefined) held.sha256s.push(sha256)
    byUrl.set(url, held)
  }
  return byUrl
})

// The listing, split by whether the archive holds each URL, and the run's
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
  const held = yield* heldRecords()
  yield* putJson(yield* runKey(run.id), yield* runningResult(run))
  return {
    fresh: listed.filter((report) => !held.has(report.sourceUrl)),
    held: listed.filter((report) => held.has(report.sourceUrl)),
  }
})

// Concurrent HEADs to www.idx.id, kept modest out of courtesy to IDX.
const HEAD_CONCURRENCY = 4

const Checked = Schema.Struct({
  // How many held URLs answered their HEAD.
  checked: Schema.Number,
  // Held URLs whose ETag no record has, with the ETag their HEAD answered.
  changed: Schema.Array(
    Schema.Struct({ sourceUrl: Schema.String, etag: Schema.String })
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
// is recorded, and the next run checks it again. So is one whose ETag is over
// MAX_ETAG_BYTES, which the step's result couldn't carry.
const head = Effect.fnUntraced(function* (
  held: Plan["held"]
): Effect.fn.Return<typeof Checked.Type, BucketError, StepServices> {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const records = yield* heldRecords()
  const answers = yield* Effect.forEach(
    held,
    ({ sourceUrl, fetchUrl }) =>
      client.head(fetchUrl).pipe(
        Effect.flatMap(
          Effect.fnUntraced(function* (response) {
            const etag = response.headers["etag"]
            if (etag === undefined) return { sourceUrl, etag, changed: false }
            if ((yield* jsonBytes(etag)) > MAX_ETAG_BYTES)
              return yield* Effect.fail(etag)
            const seen = yield* Effect.forEach(
              records.get(sourceUrl)?.etags ?? [],
              comparableEtag
            )
            return {
              sourceUrl,
              etag,
              changed: !seen.includes(yield* comparableEtag(etag)),
            }
          })
        ),
        Effect.mapError(() => sourceUrl),
        Effect.result
      ),
    { concurrency: HEAD_CONCURRENCY }
  )
  const answered = answers
    .filter(Result.isSuccess)
    .map(({ success }) => success)
  return {
    checked: answered.length,
    changed: answered.flatMap(({ sourceUrl, etag, changed }) =>
      changed && etag !== undefined ? [{ sourceUrl, etag }] : []
    ),
    unanswered: answers.filter(Result.isFailure).map(({ failure }) => failure),
  }
})

// The most a report download may be: IDX's files are ~400 KB, and a Worker
// has 128 MB.
export const MAX_REPORT_BYTES = 16 * 1024 * 1024

// Downloads one report from www.idx.id and stores it: the .xlsx once per
// hash, then its record, whose presence marks the version complete.
// `headEtag` is what the `head` step saw for a changed held URL. A GET that
// sends no ETag records it instead, so the next HEAD finds it held rather than
// downloading the file on every run, and so does a GET whose ETag is over
// MAX_ETAG_BYTES. Its record names `run`.
const archiveReport = Effect.fnUntraced(function* (
  run: ArchiveRunId,
  report: ListedReport,
  headEtag: string | null
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
  const bytes = yield* readCapped(
    response,
    MAX_REPORT_BYTES,
    `IDX's file at ${report.fetchUrl}`
  )
  const fetchedAt = yield* nowIso
  const sha256 = yield* sha256Hex(bytes)
  const getEtag = response.headers["etag"]
  const etag =
    getEtag !== undefined && (yield* jsonBytes(getEtag)) <= MAX_ETAG_BYTES
      ? getEtag
      : headEtag
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
        [RUN]: run,
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
  const changedUrls = new Set(checked.changed.map(({ sourceUrl }) => sourceUrl))
  // Decided from earlier runs' records, not from the .xlsx being there: a
  // retry of a `report:` step finds the .xlsx, and maybe the record, its
  // first attempt wrote.
  const earlier = yield* heldRecords(run.id)
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
      ({ sourceUrl, sha256 }) =>
        changedUrls.has(sourceUrl) &&
        !(earlier.get(sourceUrl)?.sha256s.includes(sha256) ?? false)
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
    error:
      error.length > MAX_RUN_ERROR_LENGTH
        ? `${error.slice(0, MAX_RUN_ERROR_LENGTH - 1)}…`
        : error,
  })
  yield* putJson(yield* runKey(run.id), result)
  return result
})

// The `report:` step's name for a report: `report:<kind>/<data date>/<SHA-256
// of its source URL>`, at most 106 characters whatever the URL's length, and
// one per URL: two URLs share a name only if their full SHA-256s collide.
const reportStepName = Effect.fnUntraced(function* (report: ListedReport) {
  const digest = yield* sha256Hex(new TextEncoder().encode(report.sourceUrl))
  return `report:${report.kind}/${report.dataDate}/${digest}`
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
  const heldByUrl = new Map(
    planned.held.map((report) => [report.sourceUrl, report])
  )
  const toStore = [
    ...planned.fresh.map((report) => ({ report, etag: null })),
    ...checked.changed.flatMap(({ sourceUrl, etag }) => {
      const report = heldByUrl.get(sourceUrl)
      return report === undefined ? [] : [{ report, etag }]
    }),
  ]
  // A report that still fails after its step's retries isn't held at that
  // ETag, so the next run retries it; this one carries on.
  const stored = yield* Effect.forEach(toStore, ({ report, etag }) =>
    Effect.flatMap(reportStepName(report), (name) =>
      steps.do(name, archiveReport(run.id, report, etag))
    ).pipe(
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
