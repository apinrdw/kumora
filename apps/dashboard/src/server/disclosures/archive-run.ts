// One disclosure run: `plan`, one `list:<day>` step per disclosure day of
// the last 7, newest first, `waiting`, one `files:<n>` step per
// FILES_PER_STEP waiting attachments, then `summary`. Each step's body is an
// Effect; the run itself only orders the steps, so it holds nothing a
// Workflow replay could change. Spec apinrdw/kumora#715 and #716.
//
// A `list:` step stores the versions the archive lacks and indexes their
// attachments as waiting; the `files:` steps store waiting attachments, at
// most FILES_PER_RUN a run, newest day first. An attachment that isn't
// stored stays waiting in the index, so the next run takes it up without
// listing its day again.
import {
  type NonRetryable,
  STEP_RESULT_BYTES,
  type StepConfig,
  type StepFailed,
  type WorkflowSteps,
} from "@workspace/server"
import { wibDateAt } from "@workspace/relay"
import { DateTime, Duration, Effect } from "effect"
import { HttpClient, type HttpClientError } from "effect/http"

import type { ArchiveDb } from "../archive/archive-db.ts"
import { ArchiveBucket } from "../archive/bucket.ts"
import { readCapped } from "../archive/capped-body.ts"
import { failingRun } from "../archive/failing-run.ts"
import { type Run, runError, STORE_SLOWEST_ANSWER } from "../archive/run.ts"
import {
  indexVersions,
  isAttachmentStored,
  markAttachmentFailed,
  markAttachmentStored,
  recordDayListed,
  heldVersions,
  type WaitingAttachment,
  waitingAttachments,
  waitingCount,
} from "./disclosure-index.ts"
import { IDX_REQUEST_TIMEOUT } from "./http.ts"
import {
  attachmentKey,
  disclosureDayOf,
  DisclosureLanguage,
  versionKey,
} from "./key.ts"
import {
  forEachListedPage,
  type ListedVersion,
  MAX_KEY_LENGTH,
  MAX_PATH_LENGTH,
} from "./listing.ts"
import {
  DisclosureRunResult,
  type DisclosureTrigger,
  type NotStoredAttachment,
  runningDisclosureResult,
} from "./run-result.ts"
import { writeDisclosureRun } from "./runs.ts"

type DisclosureRun = Run<DisclosureTrigger>

type StepServices = ArchiveBucket | ArchiveDb | HttpClient.HttpClient

// The disclosure days each run lists again: today in WIB and the 6 before,
// so a version or attachment IDX adds within a week is stored.
const RECENT_DAYS = 7

// Attachments one `files:` step stores, FILE_CONCURRENCY at a time.
const FILES_PER_STEP = 25
const FILE_CONCURRENCY = 2

// The most bytes one attachment may take; past it, it isn't stored and
// waits for a later run. IDX's average ~220 KB (spec apinrdw/kumora#715); a
// step holds FILE_CONCURRENCY at once in a Worker's 128 MB.
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024

// The bytes a waiting attachment takes in the `waiting` step's result at
// most: its key and path at their longest, and JSON's quotes and names.
const MAX_WAITING_BYTES = MAX_KEY_LENGTH + MAX_PATH_LENGTH + 64

// Room in a step result for what doesn't grow with its attachments.
const FIXED_RESULT_BYTES = 4096

// The most attachments one run stores: a round number below as many as the
// `waiting` step's result can name, 1,573. At ~220 KB each, ~220 MB a run.
export const FILES_PER_RUN = Math.min(
  1000,
  Math.floor((STEP_RESULT_BYTES - FIXED_RESULT_BYTES) / MAX_WAITING_BYTES)
)

// The most attachments a run's record names among those it couldn't store;
// it counts all of them in attachmentsWaiting.
const MAX_NOT_STORED_SHOWN = 50

// Versions a `list:` step stores at once: each is a check and a put.
const VERSION_CONCURRENCY = 10

// A `files:` step's timeout: its rounds of FILE_CONCURRENCY downloads in
// turn, each a request of at most IDX_REQUEST_TIMEOUT and its four calls to
// the stores (stored already, the object there, the put, the index).
// `list:`, `plan`, `waiting` and `summary` keep the runtime's 10 minutes: a
// usual day's two pages and ~400 versions at VERSION_CONCURRENCY take
// ~2 minutes at STORE_SLOWEST_ANSWER.
const filesStep = Effect.sync((): StepConfig => ({
  timeout:
    Math.ceil(FILES_PER_STEP / FILE_CONCURRENCY) *
    (Duration.toMillis(IDX_REQUEST_TIMEOUT) +
      4 * Duration.toMillis(STORE_SLOWEST_ANSWER)),
}))

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

// The RECENT_DAYS disclosure days to the run's start, newest first.
const recentDays = Effect.fnUntraced(function* (run: DisclosureRun) {
  const start = DateTime.fromDateUnsafe(run.startedAt)
  return yield* Effect.forEach(
    Array.from({ length: RECENT_DAYS }, (_, back) => back),
    (back) => wibDateAt(DateTime.subtract(start, { days: back }))
  )
})

// The run's `running` record, and the days it lists. Its row already holds
// the claim: its start inserted it (../archive/runs.ts).
const plan = Effect.fnUntraced(function* (run: DisclosureRun) {
  yield* writeDisclosureRun(yield* runningDisclosureResult(run))
  return yield* recentDays(run)
})

// Stores a version as IDX listed it, unless the bucket holds it: a stored
// version is never written again.
// Decision: a stored disclosure version or attachment is never fetched again
// (apps/dashboard/docs/adr/0137-a-stored-disclosure-is-never-fetched-again.md)
const storeVersion = Effect.fnUntraced(function* (
  language: DisclosureLanguage,
  version: ListedVersion
) {
  const bucket = yield* ArchiveBucket
  const key = yield* versionKey(version.key, language)
  if (!(yield* bucket.exists(key)))
    yield* bucket.put(key, version.reply, { contentType: "application/json" })
  return {
    key: version.key,
    language,
    day: yield* disclosureDayOf(version.key),
    paths: version.paths,
  }
})

// Lists `day` in both languages, and stores each version the index lacks,
// indexing its attachments to be stored. What it stores comes from the
// index, so a retry that finds its first attempt's versions stores none
// again.
const listDay = Effect.fnUntraced(function* (day: string) {
  let versionsAdded = 0
  for (const language of DisclosureLanguage.literals) {
    const held = yield* heldVersions(day, language)
    yield* forEachListedPage(
      day,
      language,
      Effect.fnUntraced(function* (versions) {
        const fresh = versions.filter(({ key }) => !held.has(key))
        const stored = yield* Effect.forEach(
          fresh,
          (version) => storeVersion(language, version),
          { concurrency: VERSION_CONCURRENCY }
        )
        yield* indexVersions(stored, yield* nowIso)
        for (const { key } of fresh) held.add(key)
        versionsAdded += fresh.length
      })
    )
  }
  yield* recordDayListed(day, yield* nowIso)
  return { versionsAdded }
})

// Why an attachment couldn't be downloaded; the next run tries it again.
const downloadFailure = Effect.fnUntraced(function* (
  error: HttpClientError.HttpClientError | NonRetryable
) {
  return yield* runError(
    error._tag === "NonRetryable"
      ? error.message
      : error.reason._tag === "StatusCodeError"
        ? `IDX answered ${error.reason.response.status}`
        : `IDX couldn't be read: ${error.reason.message}`
  )
})

// What a `files:` step did with one attachment.
type FileOutcome =
  | { readonly stored: true }
  | {
      readonly stored: false
      readonly attachment: WaitingAttachment
      readonly message: string
    }

const STORED: FileOutcome = { stored: true }

// Downloads one attachment from www.idx.id and stores it, unless the index
// says it is stored: a retry of its step finds what its first attempt
// stored. A download that fails is recorded in the index and left waiting;
// a store that fails fails the step, which the runtime retries.
// Decision: a stored disclosure version or attachment is never fetched again
// (apps/dashboard/docs/adr/0137-a-stored-disclosure-is-never-fetched-again.md)
const storeAttachment = Effect.fnUntraced(function* (
  attachment: WaitingAttachment
) {
  if (yield* isAttachmentStored(attachment)) return STORED
  const url = `https://www.idx.id${attachment.path}`
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const downloaded = yield* client.get(url).pipe(
    Effect.flatMap((response) =>
      readCapped(response, MAX_ATTACHMENT_BYTES, `IDX's file at ${url}`).pipe(
        Effect.map((bytes) => ({
          bytes,
          contentType:
            response.headers["content-type"] ?? "application/octet-stream",
        }))
      )
    ),
    Effect.result
  )
  if (downloaded._tag === "Failure") {
    const message = yield* downloadFailure(downloaded.failure)
    yield* markAttachmentFailed(attachment, yield* nowIso, message)
    const failed: FileOutcome = { stored: false, attachment, message }
    return failed
  }
  const { bytes, contentType } = downloaded.success
  const bucket = yield* ArchiveBucket
  const key = yield* attachmentKey(attachment.disclosure, attachment.path)
  if (!(yield* bucket.exists(key)))
    yield* bucket.put(key, bytes, { contentType })
  yield* markAttachmentStored(attachment, yield* nowIso, bytes.length)
  return STORED
})

const storeFiles = Effect.fnUntraced(function* (
  attachments: ReadonlyArray<WaitingAttachment>
) {
  return yield* Effect.forEach(attachments, storeAttachment, {
    concurrency: FILE_CONCURRENCY,
  })
})

const finishedResult = Effect.fnUntraced(function* (run: DisclosureRun) {
  return { ...(yield* runningDisclosureResult(run)), finishedAt: yield* nowIso }
})

const summary = Effect.fnUntraced(function* (
  run: DisclosureRun,
  days: ReadonlyArray<string>,
  versionsAdded: number,
  attachmentsStored: number,
  notStored: ReadonlyArray<NotStoredAttachment>
) {
  const attachmentsWaiting = yield* waitingCount(days)
  const result = DisclosureRunResult.make({
    ...(yield* finishedResult(run)),
    // Anything of the listed days left waiting makes the run partial: a
    // download that failed, or one past the run's budget.
    outcome:
      notStored.length === 0 && attachmentsWaiting === 0
        ? "complete"
        : "partial",
    days,
    versionsAdded,
    attachmentsStored,
    attachmentsWaiting,
    notStored: notStored.slice(0, MAX_NOT_STORED_SHOWN),
  })
  yield* writeDisclosureRun(result)
  return result
})

// A listing couldn't be read: the run is failed with its message.
const recordFailure = Effect.fnUntraced(function* (
  run: DisclosureRun,
  days: ReadonlyArray<string>,
  error: string
) {
  const result = DisclosureRunResult.make({
    ...(yield* finishedResult(run)),
    outcome: "failed",
    days,
    error: yield* runError(error),
  })
  yield* writeDisclosureRun(result)
  return result
})

export const disclosureRun = Effect.fn("disclosureRun")(function* (
  steps: WorkflowSteps<StepServices>,
  run: DisclosureRun
): Effect.fn.Return<DisclosureRunResult, StepFailed> {
  const days = yield* steps.do("plan", plan(run))
  let versionsAdded = 0
  for (const day of days) {
    const listed = yield* failingRun(
      steps,
      steps.do(`list:${day}`, listDay(day)),
      (message) => recordFailure(run, days, message)
    )
    versionsAdded += listed.versionsAdded
  }
  const waiting = yield* steps.do(
    "waiting",
    waitingAttachments(days, FILES_PER_RUN)
  )
  const config = yield* filesStep
  let attachmentsStored = 0
  const notStored: Array<NotStoredAttachment> = []
  for (let start = 0; start < waiting.length; start += FILES_PER_STEP) {
    const batch = waiting.slice(start, start + FILES_PER_STEP)
    const outcomes = yield* steps
      .do(`files:${start / FILES_PER_STEP}`, storeFiles(batch), config)
      .pipe(
        // Its stores failed past their retries: none of its attachments
        // counts as stored by this run, and each waits for the next.
        Effect.catchTag("StepFailed", ({ message }) =>
          Effect.succeed(
            batch.map((attachment): FileOutcome => ({
              stored: false,
              attachment,
              message,
            }))
          )
        )
      )
    for (const outcome of outcomes)
      if (outcome.stored) attachmentsStored += 1
      else
        notStored.push({
          disclosure: outcome.attachment.disclosure,
          path: outcome.attachment.path,
          message: outcome.message,
        })
  }
  return yield* steps.do(
    "summary",
    summary(run, days, versionsAdded, attachmentsStored, notStored)
  )
})
