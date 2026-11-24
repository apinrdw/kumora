// One KSEI archive run: `plan`, `head`, then one `report:<filename>` step per
// file to store, then `summary`. Each step's body is an Effect; the run
// itself only orders the steps, so it holds nothing a Workflow replay could
// change. Spec apinrdw/kumora#327, "The KSEI archive run".
import {
  jsonBytes,
  NonRetryable,
  type StepConfig,
  type StepFailed,
  type WorkflowSteps,
} from "@workspace/server"
import { DateTime, Duration, Effect, Result, Schema } from "effect"
import { HttpClient, type HttpClientError } from "effect/http"

import type { ArchiveDb, ArchiveDbError } from "../archive/archive-db.ts"
import { ArchiveBucket, type BucketError } from "../archive/bucket.ts"
import { readCapped } from "../archive/capped-body.ts"
import { sha256Hex } from "../archive/hash.ts"
import {
  comparableEtag,
  HEAD_CONCURRENCY,
  headHeld,
  MAX_ETAG_BYTES,
} from "../archive/head.ts"
import { ETAG, heldIn, RUN, SHA256 } from "../archive/held.ts"
import { md5Hex } from "../archive/md5.ts"
import { failingRun } from "../archive/failing-run.ts"
import {
  PLAN_STORE_CALLS,
  REPORT_STORE_CALLS,
  type Run,
  type RunId,
  runError,
  REPORTS_PREFIX,
  STORE_SLOWEST_ANSWER,
  storedReports,
} from "../archive/run.ts"
import { inArchive } from "./coverage.ts"
import {
  PROBE_HEADS_IN_TURN,
  PROBE_YEARS,
  probe,
  type Probed,
  seed,
} from "./deep.ts"
import { FILENAME, recordsByFilename } from "./held.ts"
import { KSEI_REQUEST_TIMEOUT, KSEI_SLOWEST_ANSWER } from "./http.ts"
import { recordKey, reportKey } from "./keys.ts"
import { KseiReportKind } from "./kind.ts"
import { fetchListing, KseiFilename, ListedKseiReport } from "./listing.ts"
import { kseiIndex } from "./report-index.ts"
import {
  type DeepFinds,
  KseiRunResult,
  type KseiTrigger,
  ListingFailure,
  runningKseiResult,
} from "./run-result.ts"
import { writeKseiRun } from "./runs.ts"

type KseiRun = Run<KseiTrigger>

type StepServices = ArchiveBucket | ArchiveDb | HttpClient.HttpClient

// A step that asks KSEI times out when the requests it waits on in turn
// should all have answered. `plan` (both listings at once) and each
// `report:` (one file) wait on one KSEI request, and get its
// KSEI_REQUEST_TIMEOUT (http.ts), which as a step also bounds reading the
// body, plus STORE_SLOWEST_ANSWER for each of their calls in turn to the
// archive's stores (PLAN_STORE_CALLS, REPORT_STORE_CALLS, ../archive/run.ts).
// `seed`, `summary` and `failed` ask KSEI nothing and keep the runtime's 10
// minutes.
const kseiStep = (storeCalls: number) =>
  Effect.sync((): StepConfig => ({
    timeout:
      Duration.toMillis(KSEI_REQUEST_TIMEOUT) +
      storeCalls * Duration.toMillis(STORE_SLOWEST_ANSWER),
  }))

// `head` and `probe:` get their longest run of HEADs in turn at
// KSEI's slowest answer, plus one stuck request: 4.4 minutes for 72 held
// files, 7.6 for a probe. A flat 2 minutes timed out a healthy probe (42
// HEADs at 3 s), and each retry restarted its year. See apinrdw/kumora#327.
const batchStep = (headsInTurn: number) =>
  Effect.sync((): StepConfig => ({
    timeout:
      Duration.toMillis(KSEI_REQUEST_TIMEOUT) +
      headsInTurn * Duration.toMillis(KSEI_SLOWEST_ANSWER),
  }))

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
  filename: KseiFilename,
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

// KSEI answered a KSEI report's URL with a redirect: it has no such report.
class NotOnKsei extends Schema.TaggedError<NotOnKsei>()("NotOnKsei", {
  message: Schema.String,
}) {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

// Both listings, split by whether the archive holds each filename, and the
// run's `running` record. A listing that can't be read skips its kind; with
// neither, the run fails. Its row already holds the claim: its start
// inserted it (../archive/runs.ts). First, the report index gains every
// record of reports/ it lacks.
const plan = Effect.fnUntraced(function* (
  run: KseiRun
): Effect.fn.Return<
  Plan,
  NoListingReadable | BucketError | ArchiveDbError,
  StepServices
> {
  const objects = yield* (yield* ArchiveBucket).list(REPORTS_PREFIX)
  // Decision: the report index is a copy of R2 that each archive run heals
  // (apps/dashboard/docs/adr/0125-the-report-index-is-a-copy-of-r2-that-each-archive-run-heals.md)
  yield* kseiIndex.heal(objects)
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
  // A listed file before the archive's first month isn't stored.
  const listed = yield* Effect.filter(
    listings.filter(Result.isSuccess).flatMap(({ success }) => success),
    ({ periodEnd }) => inArchive(periodEnd)
  )
  const held = yield* heldIn(objects, FILENAME)
  yield* writeKseiRun(yield* runningKseiResult(run))
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
    yield* recordsByFilename()
  )
  return {
    checked,
    changed: changed.map(({ key, etag }) => ({ filename: key, etag })),
    unanswered,
  }
})

// The most a file download may be: KSEI's are 104–158 KB, and a Worker has
// 128 MB.
export const MAX_KSEI_REPORT_BYTES = 8 * 1024 * 1024

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
  run: RunId,
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
            message: `KSEI has no report at ${report.url}: it redirects`,
          })
        )
    )
  )
  const bytes = yield* readCapped(
    response,
    MAX_KSEI_REPORT_BYTES,
    `KSEI's report at ${report.url}`
  )
  if (!(yield* isZip(bytes)))
    return yield* new NonRetryable({
      message: `KSEI's report at ${report.url} isn't a zip`,
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
  const record = JSON.stringify({
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
  })
  yield* bucket.put(key, record, {
    contentType: "application/json",
    customMetadata: {
      [FILENAME]: report.filename,
      [SHA256]: sha256,
      [RUN]: run,
      ...(etag === null ? {} : { [ETAG]: etag }),
    },
  })
  // Decision: the report index is a copy of R2 that each archive run heals
  // (apps/dashboard/docs/adr/0125-the-report-index-is-a-copy-of-r2-that-each-archive-run-heals.md)
  yield* kseiIndex.indexRecord(key, bytes.length, record)
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
  run: RunId,
  report: ListedKseiReport,
  headEtag: string | null
) =>
  archiveReport(run, report, headEtag).pipe(
    Effect.catchTag("NotOnKsei", ({ message }) =>
      Effect.fail(new NonRetryable({ message }))
    )
  )

// A Deep backfill's find, null when KSEI redirects it.
// A seeded file KSEI no longer serves is no failure: Wayback saw it
// once, and its month is probed like any other missing month. See
// apinrdw/kumora#330.
const archiveFind = (run: RunId, report: ListedKseiReport) =>
  archiveReport(run, report, null).pipe(
    Effect.catchTag("NotOnKsei", () => Effect.succeed(null))
  )

// One `report:` step per find, each a file no listing names.
const storeFinds = Effect.fnUntraced(function* (
  steps: WorkflowSteps<StepServices>,
  run: KseiRun,
  finds: ReadonlyArray<ListedKseiReport>
) {
  const reportStep = yield* kseiStep(REPORT_STORE_CALLS)
  const stored = yield* Effect.forEach(finds, (report) =>
    steps
      .do(`report:${report.filename}`, archiveFind(run.id, report), reportStep)
      .pipe(
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
  const probeStep = yield* batchStep(PROBE_HEADS_IN_TURN)
  const probes = yield* Effect.forEach(
    KseiReportKind.literals.flatMap((kind) =>
      PROBE_YEARS.map((year) => ({ kind, year }))
    ),
    ({ kind, year }) =>
      steps.do(`probe:${kind}:${year}`, probe(kind, year), probeStep).pipe(
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
    // An MD5 mismatch and a Deep backfill's months not found leave the
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
  yield* writeKseiRun(result)
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
    error: yield* runError(error),
  })
  yield* writeKseiRun(result)
  return result
})

export const kseiArchiveRun = Effect.fn("kseiArchiveRun")(function* (
  steps: WorkflowSteps<StepServices>,
  run: KseiRun
): Effect.fn.Return<KseiRunResult, StepFailed> {
  const planned = yield* failingRun(
    steps,
    steps.do("plan", plan(run), yield* kseiStep(PLAN_STORE_CALLS)),
    (message) => recordPlanFailure(run, message)
  )
  const checked = yield* steps.do(
    "head",
    head(planned.held),
    yield* batchStep(Math.ceil(planned.held.length / HEAD_CONCURRENCY))
  )
  const heldByFilename = new Map<string, ListedKseiReport>(
    planned.held.map((report) => [report.filename, report])
  )
  const toStore = [
    ...planned.fresh.map((report) => ({ report, etag: null })),
    ...checked.changed.flatMap(({ filename, etag }) => {
      const report = heldByFilename.get(filename)
      return report === undefined ? [] : [{ report, etag }]
    }),
  ]
  const reportStep = yield* kseiStep(REPORT_STORE_CALLS)
  // A file that still fails after its step's retries isn't held at that
  // ETag, so the next run retries it; this one carries on. A filename names
  // one step: KseiFilename keeps it short and fit for a step name.
  const stored = yield* Effect.forEach(toStore, ({ report, etag }) =>
    steps
      .do(
        `report:${report.filename}`,
        archiveListed(run.id, report, etag),
        reportStep
      )
      .pipe(
        Effect.mapError(() => report.filename),
        Effect.result
      )
  )
  const { archived, notStored } = yield* storedReports(
    stored,
    checked.unanswered
  )
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
