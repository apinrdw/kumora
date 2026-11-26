// One disclosure run: `plan`, one `list:<day>` step per disclosure day of
// the last RECENT_DAYS, newest first, `backfill`, a `list:<day>` step per
// older day it takes up that isn't listed whole, `waiting`, one `files:<n>`
// step per FILES_PER_STEP waiting attachments, then `summary`. Each step's body is an
// Effect; the run itself only orders the steps, so it holds nothing a
// Workflow replay could change. Spec apinrdw/kumora#715, #716 and #718.
//
// A `list:` step stores the versions the archive lacks and indexes their
// attachments as waiting; the `files:` steps store waiting attachments, at
// most FILES_PER_RUN a run: the recent days' newest day first, then the
// older days' oldest first. An attachment that isn't stored stays waiting in
// the index, so the next run takes it up without listing its day again.
import {
  STEP_RESULT_BYTES,
  type StepConfig,
  type StepFailed,
  type WorkflowSteps,
} from "@workspace/server"
import { type WibDate, wibDateAt } from "@workspace/relay"
import { DateTime, Duration, Effect } from "effect"
import { HttpClient, type HttpClientError } from "effect/http"

import type { ArchiveDb } from "../archive/archive-db.ts"
import { ArchiveBucket } from "../archive/bucket.ts"
import { failingRun } from "../archive/failing-run.ts"
import { type Run, runError, STORE_SLOWEST_ANSWER } from "../archive/run.ts"
import {
  dayAfter,
  disclosureDayOf,
  FIRST_DISCLOSURE_DAY,
  listedWhole,
  RECENT_DAYS,
} from "./disclosure-day.ts"
import {
  indexVersions,
  isAttachmentStored,
  listedDays,
  markAttachmentFailed,
  markAttachmentStored,
  recordDayListed,
  recordDaysComplete,
  heldVersions,
  type WaitingAttachment,
  waitingAttachments,
  waitingCount,
} from "./disclosure-index.ts"
import { IDX_REQUEST_TIMEOUT } from "./http.ts"
import { attachmentKey, DisclosureLanguage, versionKey } from "./key.ts"
import {
  forEachListedPage,
  type ListedVersion,
  MAX_DAY_PAGES,
  MAX_KEY_LENGTH,
  MAX_PATH_LENGTH,
  PAGE_SIZE,
  storedPaths,
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

// The most days older than the recent ones one run takes up. A day of
// ~200 disclosures waits ~500 attachments, so the budget stops a run after
// two or three; the cap bounds a run's steps (at most RECENT_DAYS + 31 `list:`, 40
// `files:` and 4 more, against a Workflow's default 10,000) where days hold
// nothing, as before IDX's first disclosure or on a holiday.
const MAX_BACKFILL_DAYS = 31

// Attachments one `files:` step stores, FILE_CONCURRENCY at a time.
const FILES_PER_STEP = 25
const FILE_CONCURRENCY = 2

// How long one attachment's body may take to stream into the bucket once
// IDX has answered: ~300 MB at 1 MB/s, against IDX's average ~220 KB (spec
// apinrdw/kumora#715). One that takes longer fails as a download does. Its
// size alone never does: the body streams in, PUT_PART_BYTES at a time
// (../archive/bucket.ts), so a step holds FILE_CONCURRENCY parts at most.
const DOWNLOAD_TIMEOUT = "5 minutes"

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
// turn, each a request of at most IDX_REQUEST_TIMEOUT, its body streamed
// into the bucket within DOWNLOAD_TIMEOUT, and its three other calls to the
// stores (stored already, the object there, the index). ~85 minutes.
// `plan`, `backfill`, `waiting` and `summary` keep the runtime's 10 minutes.
const filesStep = Effect.sync((): StepConfig => ({
  timeout:
    Math.ceil(FILES_PER_STEP / FILE_CONCURRENCY) *
    (Duration.toMillis(IDX_REQUEST_TIMEOUT) +
      Duration.toMillis(DOWNLOAD_TIMEOUT) +
      3 * Duration.toMillis(STORE_SLOWEST_ANSWER)),
}))

// A `list:` step's timeout: both languages' MAX_DAY_PAGES pages in turn,
// each a request and its versions' check and put, VERSION_CONCURRENCY at a
// time, then the index's held versions, its insert and the day's record.
// ~89 minutes; a usual day's ~400 versions take ~2 at STORE_SLOWEST_ANSWER,
// but an annual-report deadline a run backfills would take ~18, past the
// runtime's 10: IDX listed 1,773 disclosures in each language on 2024-04-30.
const listStep = Effect.sync((): StepConfig => ({
  timeout:
    DisclosureLanguage.literals.length *
    MAX_DAY_PAGES *
    (Duration.toMillis(IDX_REQUEST_TIMEOUT) +
      (2 * Math.ceil(PAGE_SIZE / VERSION_CONCURRENCY) + 3) *
        Duration.toMillis(STORE_SLOWEST_ANSWER)),
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
// version is never written again, and its attachments are those the bucket's
// reply lists, however IDX lists it now. So an attempt that wrote the object
// and failed to index it leaves a retry indexing what it wrote.
// Decision: a stored disclosure version or attachment is never fetched again
// (apps/dashboard/docs/adr/0137-a-stored-disclosure-is-never-fetched-again.md)
const storeVersion = Effect.fnUntraced(function* (
  language: DisclosureLanguage,
  version: ListedVersion
) {
  const bucket = yield* ArchiveBucket
  const key = yield* versionKey(version.key, language)
  const stored = yield* bucket.get(key)
  if (stored === undefined)
    yield* bucket.put(key, version.reply, { contentType: "application/json" })
  return {
    key: version.key,
    language,
    day: yield* disclosureDayOf(version.key),
    paths:
      stored === undefined
        ? version.paths
        : yield* storedPaths(version.key, language, stored.body),
  }
})

// Lists `day` in both languages, and stores each version the index lacks,
// indexing its attachments to be stored. What it stores comes from the
// index, so a retry that finds its first attempt's versions stores none
// again. It counts the entries the listing skipped, and keeps why for the
// first MAX_NOT_STORED_SHOWN; none of them waits, or fails the run.
// Decision: a malformed disclosure entry is skipped, not failed
// (apps/dashboard/docs/adr/0140-a-malformed-disclosure-entry-is-skipped-not-failed.md)
const listDay = Effect.fnUntraced(function* (day: WibDate) {
  let versionsAdded = 0
  let entriesSkipped = 0
  const skipped: Array<string> = []
  for (const language of DisclosureLanguage.literals) {
    const held = yield* heldVersions(day, language)
    yield* forEachListedPage(
      day,
      language,
      Effect.fnUntraced(function* ({ versions, skipped: skippedHere }) {
        entriesSkipped += skippedHere.length
        for (const message of skippedHere.slice(
          0,
          MAX_NOT_STORED_SHOWN - skipped.length
        ))
          skipped.push(yield* runError(message))
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
  return {
    versionsAdded,
    entriesSkipped,
    skipped,
    waiting: yield* waitingCount([day]),
  }
})

// A day the run may backfill, oldest first: whether it is listed whole
// already, and if so how many of its attachments wait.
interface BackfillDay {
  readonly day: WibDate
  readonly listed: boolean
  readonly waiting: number
}

// How many attachments of the run's recent days wait, and up to
// MAX_BACKFILL_DAYS days older than them that aren't complete, oldest first
// from IDX's first disclosure day. A complete day is never among them.
// Decision: each disclosure run backfills the oldest incomplete days with its leftover budget
// (apps/dashboard/docs/adr/0138-disclosure-runs-backfill-the-oldest-incomplete-days.md)
const backfill = Effect.fnUntraced(function* (recent: ReadonlyArray<WibDate>) {
  const before = recent.at(-1) ?? FIRST_DISCLOSURE_DAY
  const listed = new Map(
    (yield* listedDays(FIRST_DISCLOSURE_DAY)).map((row) => [row.day, row])
  )
  const days: Array<BackfillDay> = []
  for (
    let day = FIRST_DISCLOSURE_DAY;
    day < before && days.length < MAX_BACKFILL_DAYS;
    day = yield* dayAfter(day)
  ) {
    const row = listed.get(day)
    if (row?.complete_at != null) continue
    const whole =
      row !== undefined && (yield* listedWhole(row.day, row.listed_at))
    days.push({ day, listed: whole, waiting: whole ? row.waiting : 0 })
  }
  return { recentWaiting: yield* waitingCount(recent), days }
})

// Of `days`, each older than the run's recent days, those now complete:
// listed whole, with nothing waiting.
const completeDays = Effect.fnUntraced(function* (
  days: ReadonlyArray<WibDate>
) {
  const [oldest] = days
  if (oldest === undefined) return []
  const complete: Array<WibDate> = []
  for (const row of yield* listedDays(oldest))
    if (
      days.includes(row.day) &&
      row.waiting === 0 &&
      (yield* listedWhole(row.day, row.listed_at))
    )
      complete.push(row.day)
  return complete
})

// Why an attachment couldn't be downloaded; the next run tries it again.
const downloadFailure = Effect.fnUntraced(function* (
  error: HttpClientError.HttpClientError
) {
  return yield* runError(
    error.reason._tag === "StatusCodeError"
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

// Downloads one attachment from www.idx.id and streams it into the bucket,
// unless the index says it is stored, or the bucket holds it: an attempt
// that wrote the object and failed to index it left the attachment stored,
// so a retry indexes the object as it is, and IDX isn't asked again. A
// download that fails, or outlasts DOWNLOAD_TIMEOUT, is recorded in the
// index and left waiting; a store that fails fails the step, which the
// runtime retries.
// Decision: a stored disclosure version or attachment is never fetched again
// (apps/dashboard/docs/adr/0137-a-stored-disclosure-is-never-fetched-again.md)
const storeAttachment = Effect.fnUntraced(function* (
  attachment: WaitingAttachment
) {
  if (yield* isAttachmentStored(attachment)) return STORED
  const bucket = yield* ArchiveBucket
  const key = yield* attachmentKey(attachment.disclosure, attachment.path)
  const held = yield* bucket.size(key)
  if (held !== undefined) {
    yield* markAttachmentStored(attachment, yield* nowIso, held)
    return STORED
  }
  const url = `https://www.idx.id${attachment.path}`
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const stored = yield* client.get(url).pipe(
    Effect.flatMap((response) =>
      bucket.putStream(key, response.stream, {
        contentType:
          response.headers["content-type"] ?? "application/octet-stream",
      })
    ),
    Effect.map((bytes) => ({ bytes, message: undefined })),
    Effect.catchTag("HttpClientError", (error) =>
      Effect.map(downloadFailure(error), (message) => ({
        bytes: 0,
        message,
      }))
    ),
    Effect.timeoutOrElse({
      duration: DOWNLOAD_TIMEOUT,
      orElse: () =>
        Effect.succeed({
          bytes: 0,
          message: `IDX's file didn't download in ${DOWNLOAD_TIMEOUT}`,
        }),
    })
  )
  if (stored.message !== undefined) {
    yield* markAttachmentFailed(attachment, yield* nowIso, stored.message)
    const failed: FileOutcome = {
      stored: false,
      attachment,
      message: stored.message,
    }
    return failed
  }
  yield* markAttachmentStored(attachment, yield* nowIso, stored.bytes)
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

// What a run has done so far, which its record carries.
type RunProgress = Pick<
  DisclosureRunResult,
  | "days"
  | "backfillDays"
  | "versionsAdded"
  | "entriesSkipped"
  | "skipped"
  | "attachmentsStored"
  | "notStored"
>

// Records the backfilled days now complete, and the run's result.
const summary = Effect.fnUntraced(function* (
  run: DisclosureRun,
  progress: RunProgress
) {
  const { days, backfillDays, entriesSkipped, notStored } = progress
  yield* recordDaysComplete(yield* completeDays(backfillDays), yield* nowIso)
  const attachmentsWaiting = yield* waitingCount([...days, ...backfillDays])
  const result = DisclosureRunResult.make({
    ...(yield* finishedResult(run)),
    ...progress,
    // Anything of the days it took up left waiting makes the run partial: a
    // download that failed, or one past the run's budget, which the next
    // run takes up first. So does a listing entry it skipped.
    // Decision: each disclosure run backfills the oldest incomplete days with its leftover budget
    // (apps/dashboard/docs/adr/0138-disclosure-runs-backfill-the-oldest-incomplete-days.md)
    outcome:
      notStored.length === 0 && attachmentsWaiting === 0 && entriesSkipped === 0
        ? "complete"
        : "partial",
    attachmentsWaiting,
    skipped: progress.skipped.slice(0, MAX_NOT_STORED_SHOWN),
    notStored: notStored.slice(0, MAX_NOT_STORED_SHOWN),
  })
  yield* writeDisclosureRun(result)
  return result
})

// A listing couldn't be read: the run is failed with its message.
const recordFailure = Effect.fnUntraced(function* (
  run: DisclosureRun,
  progress: RunProgress,
  error: string
) {
  const result = DisclosureRunResult.make({
    ...(yield* finishedResult(run)),
    ...progress,
    outcome: "failed",
    skipped: progress.skipped.slice(0, MAX_NOT_STORED_SHOWN),
    notStored: progress.notStored.slice(0, MAX_NOT_STORED_SHOWN),
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
  const backfillDays: Array<WibDate> = []
  const skipped: Array<string> = []
  const notStored: Array<NotStoredAttachment> = []
  const progress = {
    days,
    backfillDays,
    versionsAdded: 0,
    entriesSkipped: 0,
    skipped,
    attachmentsStored: 0,
    notStored,
  }
  const listConfig = yield* listStep
  const list = Effect.fnUntraced(function* (day: WibDate) {
    const listed = yield* failingRun(
      steps,
      steps.do(`list:${day}`, listDay(day), listConfig),
      (message) => recordFailure(run, progress, message)
    )
    progress.versionsAdded += listed.versionsAdded
    progress.entriesSkipped += listed.entriesSkipped
    skipped.push(...listed.skipped)
    return listed.waiting
  })
  for (const day of days) yield* list(day)
  // What the recent days leave of the run's budget goes to the oldest days
  // not complete: each listed whole already is taken up as it stands, each
  // other listed first, until their waiting attachments fill the budget.
  const older = yield* steps.do("backfill", backfill(days))
  let budget = FILES_PER_RUN - older.recentWaiting
  for (const { day, listed, waiting } of older.days) {
    if (budget <= 0) break
    budget -= listed ? waiting : yield* list(day)
    backfillDays.push(day)
  }
  const waiting = yield* steps.do(
    "waiting",
    waitingAttachments([...days, ...backfillDays], FILES_PER_RUN)
  )
  const config = yield* filesStep
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
      if (outcome.stored) progress.attachmentsStored += 1
      else
        notStored.push({
          disclosure: outcome.attachment.disclosure,
          path: outcome.attachment.path,
          message: outcome.message,
        })
  }
  return yield* steps.do("summary", summary(run, progress))
})
