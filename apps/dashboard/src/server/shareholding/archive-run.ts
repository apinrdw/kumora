// One archive run: `plan`, `head`, then one `report:` step per report to
// store, then `summary`. It only stores reports: the parse runs parse them
// (parse-runs.ts). Each step's body is an Effect; the run itself only orders
// the steps, so it holds nothing a Workflow replay could change. Spec
// apinrdw/kumora#303, "The archive run".
import {
  jsonBytes,
  NonRetryable,
  type StepFailed,
  type WorkflowSteps,
} from "@workspace/server"
import { DateTime, Effect, Schema } from "effect"
import { HttpClient, type HttpClientError } from "effect/http"

import type { ArchiveDb, ArchiveDbError } from "../archive/archive-db.ts"
import { ArchiveBucket, type BucketError } from "../archive/bucket.ts"
import { readCapped } from "../archive/capped-body.ts"
import { sha256Hex } from "../archive/hash.ts"
import { headHeld, MAX_ETAG_BYTES } from "../archive/head.ts"
import { ETAG, heldIn, heldRecords, RUN, SHA256 } from "../archive/held.ts"
import { failingRun } from "../archive/failing-run.ts"
import {
  type Run,
  type RunId,
  REPORTS_PREFIX,
  runError,
  storedReports,
} from "../archive/run.ts"
import { recordKey, reportKey } from "./keys.ts"
import {
  fetchListing,
  ListedReport,
  type ListingUnreadable,
} from "./listing.ts"
import { shareholdingIndex } from "./report-index.ts"
import {
  ArchiveRunResult,
  type ArchiveTrigger,
  runningResult,
} from "./run-result.ts"
import { putRunRecord } from "./runs.ts"

type IdxRun = Run<ArchiveTrigger>

type StepServices = ArchiveBucket | ArchiveDb | HttpClient.HttpClient

// Every step keeps the runtime's 10 minutes. `plan` (the listing) and each
// `report:` (one file) wait on one IDX request, which has no timeout of its
// own (workflow.ts), so a stuck one is cut off with its step and retried.
// Their calls in turn to the archive's stores (PLAN_STORE_CALLS and
// REPORT_STORE_CALLS at STORE_SLOWEST_ANSWER each, ../archive/run.ts) take a
// small part of it.

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

// The record's custom metadata key a run reads its identity from; the others
// are ../archive/held.ts's.
const SOURCE_URL = "sourceUrl"

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

const recordsByUrl = (run?: RunId) => heldRecords(SOURCE_URL, run)

// The listing, split by whether the archive holds each URL, and the run's
// `running` record. Its row already holds the claim: its start inserted it
// (../archive/runs.ts). First, the report index gains every record of
// reports/ it lacks.
const plan = Effect.fnUntraced(function* (
  run: IdxRun
): Effect.fn.Return<
  Plan,
  ListingUnreadable | NonRetryable | BucketError | ArchiveDbError,
  StepServices
> {
  const objects = yield* (yield* ArchiveBucket).list(REPORTS_PREFIX)
  // Decision: the report index is a copy of R2 that each archive run heals
  // (apps/dashboard/docs/adr/0125-the-report-index-is-a-copy-of-r2-that-each-archive-run-heals.md)
  yield* shareholdingIndex.heal(objects)
  const listed = yield* fetchListing
  const held = yield* heldIn(objects, SOURCE_URL)
  yield* putRunRecord(yield* runningResult(run))
  return {
    fresh: listed.filter((report) => !held.has(report.sourceUrl)),
    held: listed.filter((report) => held.has(report.sourceUrl)),
  }
})

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

// A HEAD to every held URL, at its www.idx.id URL (../archive/head.ts).
const head = Effect.fnUntraced(function* (
  held: Plan["held"]
): Effect.fn.Return<typeof Checked.Type, BucketError, StepServices> {
  const { checked, changed, unanswered } = yield* headHeld(
    held.map(({ sourceUrl, fetchUrl }) => ({ key: sourceUrl, url: fetchUrl })),
    yield* recordsByUrl()
  )
  return {
    checked,
    changed: changed.map(({ key, etag }) => ({ sourceUrl: key, etag })),
    unanswered,
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
  run: RunId,
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
  const record = JSON.stringify({
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
  })
  yield* bucket.put(key, record, {
    contentType: "application/json",
    customMetadata: {
      [SOURCE_URL]: report.sourceUrl,
      [SHA256]: sha256,
      [RUN]: run,
      ...(etag === null ? {} : { [ETAG]: etag }),
    },
  })
  // Decision: the report index is a copy of R2 that each archive run heals
  // (apps/dashboard/docs/adr/0125-the-report-index-is-a-copy-of-r2-that-each-archive-run-heals.md)
  yield* shareholdingIndex.indexRecord(key, bytes.length, record)
  return {
    sourceUrl: report.sourceUrl,
    description: report.description,
    kind: report.kind,
    sha256,
    etag,
    recordKey: key,
  }
})

const finishedResult = Effect.fnUntraced(function* (run: IdxRun) {
  return { ...(yield* runningResult(run)), finishedAt: yield* nowIso }
})

const summary = Effect.fnUntraced(function* (
  run: IdxRun,
  checked: typeof Checked.Type,
  archived: ReadonlyArray<ArchivedReport>,
  notStored: ReadonlyArray<string>
) {
  const changedUrls = new Set(checked.changed.map(({ sourceUrl }) => sourceUrl))
  // Decided from earlier runs' records, not from the .xlsx being there: a
  // retry of a `report:` step finds the .xlsx, and maybe the record, its
  // first attempt wrote.
  const earlier = yield* recordsByUrl(run.id)
  const result = ArchiveRunResult.make({
    ...(yield* finishedResult(run)),
    outcome: notStored.length === 0 ? "complete" : "partial",
    reportsAdded: archived.filter(
      ({ sourceUrl }) => !changedUrls.has(sourceUrl)
    ).length,
    // Decision: a changed ETag serving held bytes adds a record but no new version
    // (apps/dashboard/docs/adr/0051-a-changed-etag-serving-held-bytes-adds-no-version.md)
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
  yield* putRunRecord(result)
  return result
})

// `plan` failed, so nothing was stored: the run is failed with its message.
const recordPlanFailure = Effect.fnUntraced(function* (
  run: IdxRun,
  error: string
) {
  const result = ArchiveRunResult.make({
    ...(yield* finishedResult(run)),
    outcome: "failed",
    error: yield* runError(error),
  })
  yield* putRunRecord(result)
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
  run: IdxRun
): Effect.fn.Return<ArchiveRunResult, StepFailed> {
  const planned = yield* failingRun(
    steps,
    steps.do("plan", plan(run)),
    (message) => recordPlanFailure(run, message)
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
  const { archived, notStored } = yield* storedReports(
    stored,
    checked.unanswered
  )
  return yield* steps.do("summary", summary(run, checked, archived, notStored))
})
