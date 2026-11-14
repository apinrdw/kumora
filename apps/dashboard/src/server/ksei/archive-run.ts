// One KSEI archive run: `plan`, `head`, then one `report:<filename>` step per
// file to store, then `summary`. Each step's body is an Effect; the run
// itself only orders the steps, so it holds nothing a Workflow replay could
// change. Spec apinrdw/kumora#327, "The KSEI archive run".
import {
  jsonBytes,
  NonRetryable,
  type StepFailed,
  type WorkflowSteps,
} from "@workspace/server"
import { DateTime, Effect, Result, Schema } from "effect"
import { HttpClient, type HttpClientError } from "effect/http"

import { ArchiveBucket, type BucketError } from "../archive/bucket.ts"
import { readCapped } from "../archive/capped-body.ts"
import { sha256Hex } from "../archive/hash.ts"
import { comparableEtag, headHeld } from "../archive/head.ts"
import { ETAG, heldRecords, RUN, SHA256 } from "../archive/held.ts"
import { md5Hex } from "../archive/md5.ts"
import { type ArchiveRunId, MAX_RUN_ERROR_LENGTH } from "../archive/run.ts"
import { recordKey, reportKey } from "./keys.ts"
import { KseiReportKind } from "./kind.ts"
import { fetchListing, ListedKseiReport } from "./listing.ts"
import {
  KseiRunResult,
  type KseiTrigger,
  ListingFailure,
  runningKseiResult,
} from "./run-result.ts"
import { putKseiRunRecord } from "./runs.ts"

export interface KseiRun {
  readonly id: ArchiveRunId
  readonly trigger: KseiTrigger
  readonly startedAt: Date
}

type StepServices = ArchiveBucket | HttpClient.HttpClient

// Each step result holds at most one ListedKseiReport per listed file, which
// MAX_LISTED_REPORTS (listing.ts) bounds. The ETags and hashes held grow with
// every record, so each step that needs them lists reports/ itself.
const Plan = Schema.Struct({
  // Listed under a filename the archive doesn't hold.
  fresh: Schema.Array(ListedKseiReport),
  // Listed under a filename it holds, for the `head` step to check.
  held: Schema.Array(ListedKseiReport),
  listingFailures: Schema.Array(ListingFailure),
})
type Plan = typeof Plan.Type

// What a `report:` step stored. Never the file's bytes: a step's result is
// at most 1 MiB.
const ArchivedReport = Schema.Struct({
  filename: Schema.String,
  kind: KseiReportKind,
  sha256: Schema.String,
  etag: Schema.NullOr(Schema.String),
  md5Mismatch: Schema.Boolean,
  recordKey: Schema.String,
})
type ArchivedReport = typeof ArchivedReport.Type

// Neither listing could be read: the run fails with both messages.
class NoListingReadable extends Schema.TaggedError<NoListingReadable>()(
  "NoListingReadable",
  { message: Schema.String }
) {}

// The record's custom metadata key a run reads its identity from; the others
// are ../archive/held.ts's. Identity is the filename, not the URL: KSEI moved
// every file to a new path once with the same bytes.
const FILENAME = "filename"

// The most bytes an ETag a run keeps may take as JSON. KSEI's are a quoted
// MD5, 34.
const MAX_ETAG_BYTES = 64

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

const recordsByFilename = (run?: ArchiveRunId) => heldRecords(FILENAME, run)

// Both listings, split by whether the archive holds each filename, and the
// run's `running` record. A listing that can't be read skips its kind; with
// neither, the run fails. runs/latest.json already names the run: its start
// claimed it (../archive/runs.ts).
const plan = Effect.fnUntraced(function* (
  run: KseiRun
): Effect.fn.Return<Plan, NoListingReadable | BucketError, StepServices> {
  const listings = yield* Effect.forEach(
    KseiReportKind.literals,
    (kind) => Effect.result(fetchListing(kind)),
    { concurrency: "unbounded" }
  )
  const listingFailures = listings
    .filter(Result.isFailure)
    .map(({ failure: { kind, message } }) => ({ kind, message }))
  if (listingFailures.length === listings.length)
    return yield* new NoListingReadable({
      message: listingFailures.map(({ message }) => message).join("; "),
    })
  const listed = listings
    .filter(Result.isSuccess)
    .flatMap(({ success }) => success)
  const held = yield* recordsByFilename()
  yield* putKseiRunRecord(yield* runningKseiResult(run))
  return {
    fresh: listed.filter((report) => !held.has(report.filename)),
    held: listed.filter((report) => held.has(report.filename)),
    listingFailures,
  }
})

const Checked = Schema.Struct({
  // How many held filenames answered their HEAD.
  checked: Schema.Number,
  // Held filenames whose ETag no record has, with the ETag their HEAD
  // answered.
  changed: Schema.Array(
    Schema.Struct({ filename: Schema.String, etag: Schema.String })
  ),
  // Held filenames whose HEAD failed, a redirect included.
  unanswered: Schema.Array(Schema.String),
})

// A HEAD to every held file the listings name today, at the URL listed now
// (../archive/head.ts). Deep-backfill finds and files the listings dropped
// aren't checked.
const head = Effect.fnUntraced(function* (
  held: Plan["held"]
): Effect.fn.Return<typeof Checked.Type, BucketError, StepServices> {
  const { checked, changed, unanswered } = yield* headHeld(
    held.map(({ filename, url }) => ({ key: filename, url })),
    yield* recordsByFilename(),
    MAX_ETAG_BYTES
  )
  return {
    checked,
    changed: changed.map(({ key, etag }) => ({ filename: key, etag })),
    unanswered,
  }
})

// The most a file download may be: KSEI's are 104–158 KB, and a Worker has
// 128 MB.
export const MAX_REPORT_BYTES = 8 * 1024 * 1024

// A zip starts with PK.
const isZip = (bytes: Uint8Array) =>
  Effect.sync(() => bytes[0] === 0x50 && bytes[1] === 0x4b)

// Downloads one file from KSEI and stores it: the .zip once per hash, then
// its record, whose presence marks the version complete. `headEtag` is what
// the `head` step saw for a changed held file, recorded when the GET sends
// no usable ETag. A redirect or a body that isn't a zip means KSEI has no
// such file, which no retry changes. Its record names `run`.
const archiveReport = Effect.fnUntraced(function* (
  run: ArchiveRunId,
  report: ListedKseiReport,
  headEtag: string | null
): Effect.fn.Return<
  ArchivedReport,
  HttpClientError.HttpClientError | NonRetryable | BucketError,
  StepServices
> {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const response = yield* client.get(report.url).pipe(
    Effect.catchIf(
      ({ reason }) =>
        reason._tag === "StatusCodeError" &&
        reason.response.status >= 300 &&
        reason.response.status < 400,
      () =>
        Effect.fail(
          new NonRetryable({
            message: `KSEI has no file at ${report.url}: it redirects`,
          })
        )
    )
  )
  const bytes = yield* readCapped(
    response,
    MAX_REPORT_BYTES,
    `KSEI's file at ${report.url}`
  )
  if (!(yield* isZip(bytes)))
    return yield* new NonRetryable({
      message: `KSEI's file at ${report.url} isn't a zip`,
    })
  const fetchedAt = yield* nowIso
  const sha256 = yield* sha256Hex(bytes)
  const md5 = yield* md5Hex(bytes)
  const getEtag = response.headers["etag"]
  const etag =
    getEtag !== undefined && (yield* jsonBytes(getEtag)) <= MAX_ETAG_BYTES
      ? getEtag
      : headEtag
  const md5Mismatch = etag !== null && (yield* comparableEtag(etag)) !== md5
  const contentLength = response.headers["content-length"]
  const bucket = yield* ArchiveBucket
  const zipKey = yield* reportKey(report.kind, report.periodEnd, sha256)
  if (!(yield* bucket.exists(zipKey)))
    yield* bucket.put(zipKey, bytes, { contentType: "application/zip" })
  const key = yield* recordKey(
    report.kind,
    report.periodEnd,
    sha256,
    fetchedAt,
    { filename: report.filename, etag }
  )
  yield* bucket.put(
    key,
    JSON.stringify({
      kind: report.kind,
      periodEnd: report.periodEnd,
      filename: report.filename,
      url: report.url,
      listing: report.listing,
      etag,
      md5,
      lastModified: response.headers["last-modified"] ?? null,
      contentLength: contentLength === undefined ? null : Number(contentLength),
      fetchedAt,
      sha256,
      ...(md5Mismatch ? { md5Mismatch } : {}),
    }),
    {
      contentType: "application/json",
      customMetadata: {
        [FILENAME]: report.filename,
        [SHA256]: sha256,
        [RUN]: run,
        ...(etag === null ? {} : { [ETAG]: etag }),
      },
    }
  )
  return {
    filename: report.filename,
    kind: report.kind,
    sha256,
    etag,
    md5Mismatch,
    recordKey: key,
  }
})

const finishedResult = Effect.fnUntraced(function* (run: KseiRun) {
  return { ...(yield* runningKseiResult(run)), finishedAt: yield* nowIso }
})

const summary = Effect.fnUntraced(function* (
  run: KseiRun,
  planned: Plan,
  checked: typeof Checked.Type,
  archived: ReadonlyArray<ArchivedReport>,
  notStored: ReadonlyArray<string>
) {
  const changed = new Set(checked.changed.map(({ filename }) => filename))
  // Decided from earlier runs' records, not from the .zip being there: a
  // retry of a `report:` step finds the .zip, and maybe the record, its
  // first attempt wrote.
  const earlier = yield* recordsByFilename(run.id)
  const result = KseiRunResult.make({
    ...(yield* finishedResult(run)),
    // Decision: an MD5 mismatch is flagged and counted but stored, and
    // leaves the run complete: the bytes are what KSEI serves. See
    // apinrdw/kumora#327.
    outcome:
      notStored.length === 0 && planned.listingFailures.length === 0
        ? "complete"
        : "partial",
    reportsAdded: archived.filter(({ filename }) => !changed.has(filename))
      .length,
    // A changed ETag that serves bytes a record of its filename already
    // holds adds a record but no new version, as in the shareholding
    // archive (apinrdw/kumora#307).
    newVersions: archived.filter(
      ({ filename, sha256 }) =>
        changed.has(filename) &&
        !(earlier.get(filename)?.sha256s.includes(sha256) ?? false)
    ).length,
    reportsChecked: checked.checked,
    md5Mismatches: archived
      .filter(({ md5Mismatch }) => md5Mismatch)
      .map(({ filename }) => filename),
    listingFailures: planned.listingFailures,
    notStored,
  })
  yield* putKseiRunRecord(result)
  return result
})

// `plan` failed, so nothing was stored: the run is failed with its message.
const recordPlanFailure = Effect.fnUntraced(function* (
  run: KseiRun,
  error: string
) {
  const result = KseiRunResult.make({
    ...(yield* finishedResult(run)),
    outcome: "failed",
    error:
      error.length > MAX_RUN_ERROR_LENGTH
        ? `${error.slice(0, MAX_RUN_ERROR_LENGTH - 1)}…`
        : error,
  })
  yield* putKseiRunRecord(result)
  return result
})

export const kseiArchiveRun = Effect.fn("kseiArchiveRun")(function* (
  steps: WorkflowSteps<StepServices>,
  run: KseiRun
): Effect.fn.Return<KseiRunResult, StepFailed> {
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
  const heldByFilename = new Map(
    planned.held.map((report) => [report.filename, report])
  )
  const toStore = [
    ...planned.fresh.map((report) => ({ report, etag: null })),
    ...checked.changed.flatMap(({ filename, etag }) => {
      const report = heldByFilename.get(filename)
      return report === undefined ? [] : [{ report, etag }]
    }),
  ]
  // A file that still fails after its step's retries isn't held at that
  // ETag, so the next run retries it; this one carries on. A filename names
  // one step: KseiFilename keeps it short and fit for a step name.
  const stored = yield* Effect.forEach(toStore, ({ report, etag }) =>
    steps
      .do(`report:${report.filename}`, archiveReport(run.id, report, etag))
      .pipe(
        Effect.mapError(() => report.filename),
        Effect.result
      )
  )
  const archived = stored.filter(Result.isSuccess).map(({ success }) => success)
  // A held file whose HEAD failed may hide a change this run couldn't store.
  const notStored = [
    ...checked.unanswered,
    ...stored.filter(Result.isFailure).map(({ failure }) => failure),
  ]
  return yield* steps.do(
    "summary",
    summary(run, planned, checked, archived, notStored)
  )
})
