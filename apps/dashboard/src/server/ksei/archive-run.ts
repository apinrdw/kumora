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
import { ETAG, RUN, SHA256 } from "../archive/held.ts"
import { md5Hex } from "../archive/md5.ts"
import { type ArchiveRunId, MAX_RUN_ERROR_LENGTH } from "../archive/run.ts"
import { PROBE_YEARS, probe, type Probed, seed } from "./deep.ts"
import { FILENAME, recordsByFilename } from "./held.ts"
import { recordKey, reportKey } from "./keys.ts"
import { KseiReportKind } from "./kind.ts"
import { fetchListing, ListedKseiReport } from "./listing.ts"
import {
  type DeepFinds,
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

// KSEI answered a file with a redirect: it has no such file.
class NotOnKsei extends Schema.TaggedError<NotOnKsei>()("NotOnKsei", {
  message: Schema.String,
}) {}

// The most bytes an ETag a run keeps may take as JSON. KSEI's are a quoted
// MD5, 34.
const MAX_ETAG_BYTES = 64

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

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
// no usable ETag. A redirect fails NotOnKsei, which the caller decides on; a
// body that isn't a zip is no file either, which no retry changes. Its
// record names `run`.
const archiveReport = Effect.fnUntraced(function* (
  run: ArchiveRunId,
  report: ListedKseiReport,
  headEtag: string | null
): Effect.fn.Return<
  ArchivedReport,
  HttpClientError.HttpClientError | NotOnKsei | NonRetryable | BucketError,
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
          new NotOnKsei({
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

// A listed file: a redirect is a file KSEI lists but doesn't serve, which no
// retry changes.
const archiveListed = (
  run: ArchiveRunId,
  report: ListedKseiReport,
  headEtag: string | null
) =>
  archiveReport(run, report, headEtag).pipe(
    Effect.catchTag("NotOnKsei", ({ message }) =>
      Effect.fail(new NonRetryable({ message }))
    )
  )

// A Deep backfill's find, null when KSEI redirects it.
// Decision: a seeded file KSEI no longer serves is no failure: Wayback saw it
// once, and its month is probed like any other missing month. See
// apinrdw/kumora#330.
const archiveFind = (run: ArchiveRunId, report: ListedKseiReport) =>
  archiveReport(run, report, null).pipe(
    Effect.catchTag("NotOnKsei", () => Effect.succeed(null))
  )

// One `report:` step per find, each a file no listing names.
const storeFinds = Effect.fnUntraced(function* (
  steps: WorkflowSteps<StepServices>,
  run: KseiRun,
  finds: ReadonlyArray<ListedKseiReport>
) {
  const stored = yield* Effect.forEach(finds, (report) =>
    steps.do(`report:${report.filename}`, archiveFind(run.id, report)).pipe(
      Effect.mapError(() => report.filename),
      Effect.result
    )
  )
  return {
    archived: stored
      .filter(Result.isSuccess)
      .flatMap(({ success }) => (success === null ? [] : [success])),
    notStored: stored.filter(Result.isFailure).map(({ failure }) => failure),
  }
})

// A Deep backfill after the scheduled pass: the seed's files, then a probe
// per kind and year, then the probes' finds. `tried` are the filenames the
// scheduled pass gave a `report:` step.
const deepBackfill = Effect.fnUntraced(function* (
  steps: WorkflowSteps<StepServices>,
  run: KseiRun,
  tried: ReadonlyArray<string>
) {
  const seeded = yield* steps.do("seed", seed(tried))
  const fromSeed = yield* storeFinds(steps, run, seeded)
  const triedBefore = new Set([
    ...tried,
    ...seeded.map(({ filename }) => filename),
  ])
  const probes = yield* Effect.forEach(
    KseiReportKind.literals.flatMap((kind) =>
      PROBE_YEARS.map((year) => ({ kind, year }))
    ),
    ({ kind, year }) =>
      steps.do(`probe:${kind}:${year}`, probe(kind, year)).pipe(
        Effect.map((probed): Probed & { kind: KseiReportKind } => ({
          ...probed,
          kind,
        })),
        Effect.mapError(({ message }) => ({ kind, year, message })),
        Effect.result
      )
  )
  const probed = probes.filter(Result.isSuccess).map(({ success }) => success)
  // A find this run already tried, and failed to store, is in notStored.
  const byProbing = yield* storeFinds(
    steps,
    run,
    probed
      .flatMap(({ found }) => found)
      .filter(({ filename }) => !triedBefore.has(filename))
  )
  const monthsNotFound = (kind: KseiReportKind) =>
    probed
      .filter((step) => step.kind === kind)
      .flatMap(({ notFound }) => notFound)
  return {
    archived: [...fromSeed.archived, ...byProbing.archived],
    notStored: [...fromSeed.notStored, ...byProbing.notStored],
    finds: {
      foundFromSeed: fromSeed.archived.map(({ filename }) => filename),
      foundByProbing: byProbing.archived.map(({ filename }) => filename),
      monthsNotFound: {
        "securities-statistics": monthsNotFound("securities-statistics"),
        "securities-holdings": monthsNotFound("securities-holdings"),
      },
      probeFailures: probes
        .filter(Result.isFailure)
        .map(({ failure }) => failure),
    } satisfies DeepFinds,
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
  notStored: ReadonlyArray<string>,
  deep: DeepFinds | null
) {
  const changed = new Set(checked.changed.map(({ filename }) => filename))
  // Decided from earlier runs' records, not from the .zip being there: a
  // retry of a `report:` step finds the .zip, and maybe the record, its
  // first attempt wrote.
  const earlier = yield* recordsByFilename(run.id)
  const result = KseiRunResult.make({
    ...(yield* finishedResult(run)),
    // Decision: an MD5 mismatch and a deep run's months not found leave the
    // run complete: they are what KSEI serves, and doesn't. A probe that
    // failed is partial, like a file not stored: its months weren't looked
    // at. See apinrdw/kumora#327 and #330.
    outcome:
      notStored.length === 0 &&
      planned.listingFailures.length === 0 &&
      (deep?.probeFailures.length ?? 0) === 0
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
    deep,
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
      .do(`report:${report.filename}`, archiveListed(run.id, report, etag))
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
  const deep =
    run.trigger === "deep"
      ? yield* deepBackfill(
          steps,
          run,
          toStore.map(({ report }) => report.filename)
        )
      : undefined
  return yield* steps.do(
    "summary",
    summary(
      run,
      planned,
      checked,
      [...archived, ...(deep?.archived ?? [])],
      [...notStored, ...(deep?.notStored ?? [])],
      deep?.finds ?? null
    )
  )
})
