// Ajaib's walk of the newest closed day (spec apinrdw/kumora#244, "The
// extension: the Ajaib walk"): the day's REST tape, one 3-minute block at a
// time, then a repair pass over every block that took 2+ pages. Each page's
// rows with valid codes are posted to Production as one batch, each with its
// fields when they are valid; `end` follows the repair.
import {
  AjaibTradeNum,
  BrokerCodesProtocolVersion,
  WibDate,
  ajaibRowCodes,
  ajaibRowFields,
  ajaibSequence,
  batchRow,
  streamingEndOf,
  type BatchRow,
  type BrokerCodesBatch,
  type TradeCodes,
  type TradeFields,
  type TradeNumber,
} from "@workspace/relay"
import { Clock, DateTime, Effect, Option, Schema } from "effect"

import type { Answer } from "../broker.ts"
import type { RequestingTab } from "../pacer.ts"
import { ajaibWindowEnd, inStreamingHours, scheduleNow } from "./hours.ts"
import type { PostOutcome } from "./poster.ts"
import { halt, haltOnRefusal, settle, type WalkResult } from "./run-queue.ts"

const STATUS_PATH = "v1/stock/data/trading-day/time/"
const TAPE_PATH = "v1/stock/detail/running_trades/"

// Decision: the tape floors `last_timestamp` to a 3-minute WIB boundary and
// answers rows strictly before it, newest first; page p starts at
// (p - 1) × (size + 1), so each seam drops one row, and a second pass at
// 4,999 drops others. `total_pages` always says 2 and is ignored. Probed on
// 2026-11-12: 1..1,500,490 complete in 820 calls. See apinrdw/kumora#192.
const BLOCK = 3 * 60_000
const PAGE_SIZE = 5_000
const REPAIR_PAGE_SIZE = 4_999
// The busiest block of 2026-11-12 took 10 pages; a tape that keeps answering
// past this is not paging.
const MAX_PAGES = 40
// The first call, whose newest row gives the day's highest trade number.
const HEAD_PAGE_SIZE = 40

// Decision: the walk starts once Ajaib says CLOSED and the newest page
// carries valid codes, polling once a minute until then. A failed call
// mid-walk is retried in place every 10 s. See apinrdw/kumora#244, "Ajaib
// start".
const START_POLL = "1 minute"
const RETRY = "10 seconds"

// Where a day's walk stands, kept so a restarted worker carries on: the
// first pass's next block boundary (epoch ms, newest first) and the blocks
// that took 2+ pages; in the repair pass, the blocks still to walk again.
export const AjaibWalkPosition = Schema.Struct({
  day: WibDate,
  pass: Schema.Literals(["first", "repair", "done"]),
  next: Schema.Finite,
  repair: Schema.Array(Schema.Finite),
})
export type AjaibWalkPosition = typeof AjaibWalkPosition.Type

export interface AjaibWalkStore {
  readonly load: Effect.Effect<Option.Option<AjaibWalkPosition>>
  readonly save: (position: AjaibWalkPosition) => Effect.Effect<void>
}

// Decision: `trading-day/time/`'s market status is read from `result.status`,
// or a top-level `status`: the probe (apinrdw/kumora#192) read either, and no
// capture in this repo shows which Ajaib sends.
const MarketStatus = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ result: Schema.Struct({ status: Schema.String }) }),
    Schema.Struct({ status: Schema.String }),
  ])
)
const TapePage = Schema.fromJsonString(
  Schema.Struct({ results: Schema.Array(Schema.Unknown) })
)
// What the walk reads of a row besides its codes and fields. A row whose
// `date` isn't a WIB date is skipped, so its trade counts as missing.
const TapeRow = Schema.Struct({
  trade_num: AjaibTradeNum,
  date: WibDate,
  timestamp: Schema.Finite,
})
const decodeStatus = Schema.decodeUnknownOption(MarketStatus)
const decodePage = Schema.decodeUnknownOption(TapePage)
const decodeRow = Schema.decodeUnknownOption(TapeRow)

const tapePath = (lastTimestamp: number, page: number, size: number) =>
  Effect.succeed(
    `${TAPE_PATH}?last_timestamp=${lastTimestamp}&direction=DESC&page=${page}&page_size=${size}`
  )

interface PageRow {
  readonly date: WibDate
  readonly timestamp: number
  readonly number: TradeNumber
  readonly codes: Option.Option<TradeCodes>
  readonly fields: Option.Option<TradeFields>
}

interface TapeAnswer {
  // How many rows the page answered, valid or not, which paging counts.
  readonly size: number
  readonly rows: ReadonlyArray<PageRow>
}

// A page's rows that carry a trade number and a time; a row without either
// is skipped, so its trade counts as missing.
const pageRows = Effect.fnUntraced(function* (answer: Answer) {
  const page = decodePage(answer.body)
  if (Option.isNone(page)) return Option.none<TapeAnswer>()
  const rows: Array<PageRow> = []
  for (const raw of page.value.results) {
    const row = decodeRow(raw)
    if (Option.isNone(row)) continue
    rows.push({
      date: row.value.date,
      timestamp: row.value.timestamp,
      number: yield* ajaibSequence(row.value.trade_num),
      codes: yield* ajaibRowCodes(raw),
      fields: yield* ajaibRowFields(raw),
    })
  }
  return Option.some<TapeAnswer>({ size: page.value.results.length, rows })
})

// The batch rows of `rows` on `day` inside [from, boundary) with valid
// codes.
const blockRows = Effect.fnUntraced(function* (
  day: WibDate,
  from: number,
  boundary: number,
  rows: ReadonlyArray<PageRow>
) {
  const kept: Array<BatchRow> = []
  for (const row of rows) {
    const inBlock =
      row.date === day &&
      row.timestamp >= from &&
      row.timestamp < boundary &&
      row.number !== "0"
    if (inBlock && Option.isSome(row.codes))
      kept.push(yield* batchRow(row.number, row.codes.value, row.fields))
  }
  return kept
})

export const makeAjaibWalk = Effect.fnUntraced(function* (options: {
  readonly tab: RequestingTab & { readonly attached: Effect.Effect<boolean> }
  readonly post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
  readonly store: AjaibWalkStore
  // For the options page (progress.ts): the trades the first pass fetched
  // since the walk started, of the day's N.
  readonly trades?: (
    fetched: number,
    of: Option.Option<number>
  ) => Effect.Effect<void>
}) {
  const { tab, store } = options
  const trades = options.trades ?? (() => Effect.void)
  let fetched = 0
  let dayN = Option.none<number>()

  // Before each call: Streaming hours stop the walk in place; past
  // Ajaib's window, it can no longer serve the day; a tab that went leaves
  // the day to Stockbit.
  const guard = Effect.fnUntraced(function* (windowEnd: DateTime.Utc) {
    const now = yield* scheduleNow
    if (yield* inStreamingHours(now))
      return yield* halt({ _tag: "stopped", cause: "streaming-hours" })
    if (DateTime.isGreaterThanOrEqualTo(now, windowEnd))
      return yield* halt({ _tag: "unserved", reason: "window-passed" })
    if (!(yield* tab.attached))
      return yield* halt({ _tag: "unserved", reason: "no-tab" })
  })

  const pageToken = Effect.map(tab.request({ _tag: "page-token" }), (answer) =>
    Option.map(
      Option.filter(answer, (token) => token.status === 200),
      (token) => token.body
    )
  )

  // Decision: on a 401 the walk waits in place until the page's own token
  // refresh shows new headers; the extension never calls refresh itself.
  // See apinrdw/kumora#244, "A 401".
  // `stale` is the token read as the refused call was sent: the page may
  // have refreshed it before the 401 came back.
  const awaitNewToken = Effect.fnUntraced(function* (
    windowEnd: DateTime.Utc,
    stale: Option.Option<string>
  ) {
    while (true) {
      const token = yield* pageToken
      if (Option.isSome(token) && !Option.contains(stale, token.value)) return
      yield* Effect.sleep(RETRY)
      yield* guard(windowEnd)
    }
  })

  // One tape page, retried in place until it answers one.
  const tapePage = Effect.fnUntraced(function* (
    windowEnd: DateTime.Utc,
    path: string
  ) {
    while (true) {
      yield* guard(windowEnd)
      const sent = yield* pageToken
      const answer = yield* tab.request({ _tag: "page-fetch", path })
      if (Option.isSome(answer) && answer.value.status === 401) {
        yield* awaitNewToken(windowEnd, sent)
        continue
      }
      if (Option.isSome(answer) && answer.value.status === 200) {
        const rows = yield* pageRows(answer.value)
        if (Option.isSome(rows)) return rows.value
      }
      yield* Effect.sleep(RETRY)
    }
  })

  const post = Effect.fnUntraced(function* (
    batch: Omit<BrokerCodesBatch, "version" | "feed">
  ) {
    const outcome = yield* options.post({
      version: BrokerCodesProtocolVersion,
      feed: "Ajaib",
      ...batch,
    })
    if (outcome !== "sent") return yield* haltOnRefusal(outcome)
  })

  // A call made while waiting for the close; a tab that doesn't answer
  // leaves the day to Stockbit.
  const startCall = Effect.fnUntraced(function* (path: string) {
    const answer = yield* tab.request({ _tag: "page-fetch", path })
    if (Option.isNone(answer))
      return yield* halt({ _tag: "unserved", reason: "no-tab" })
    return answer.value
  })

  const isClosed = Effect.map(startCall(STATUS_PATH), (answer) =>
    Option.exists(
      decodeStatus(answer.body),
      (decoded) =>
        ("result" in decoded ? decoded.result.status : decoded.status) ===
        "CLOSED"
    )
  )

  // The day's highest trade number, once the tape's newest page is the
  // day's and carries codes on every row.
  const dayHead = Effect.fnUntraced(function* (day: WibDate) {
    const now = yield* Clock.currentTimeMillis
    const head = yield* startCall(yield* tapePath(now, 1, HEAD_PAGE_SIZE))
    const page =
      head.status === 200 ? yield* pageRows(head) : Option.none<never>()
    // Decision: a 200 page with no rows once Ajaib says CLOSED means the tape
    // no longer holds the day (seen Saturday 2026-11-14, after Friday's
    // evening), so Stockbit takes the day instead of the queue waiting for
    // Ajaib's window to end. Any other answer is polled again.
    if (Option.exists(page, (answer) => answer.size === 0))
      return yield* halt({ _tag: "unserved", reason: "empty-tape" })
    const rows = Option.match(page, {
      onNone: (): ReadonlyArray<PageRow> => [],
      onSome: (answer) => answer.rows,
    })
    const newest = rows[0]
    if (newest === undefined) return Option.none<TradeNumber>()
    // Decision: the tape's newest row on another date means it moved on
    // past the day (or never reached it), so Stockbit takes the day. See
    // apinrdw/kumora#244, "The tape moved on".
    if (newest.date !== day)
      return yield* halt({ _tag: "unserved", reason: "other-date" })
    if (!rows.every((row) => Option.isSome(row.codes)))
      return Option.none<TradeNumber>()
    return Option.some(
      rows.reduce(
        (max, row) => (BigInt(row.number) > BigInt(max) ? row.number : max),
        newest.number
      )
    )
  })

  // Waits for the close, then answers the day's highest trade number.
  const awaitClose = Effect.fnUntraced(function* (
    day: WibDate,
    windowEnd: DateTime.Utc
  ) {
    while (true) {
      yield* guard(windowEnd)
      if (yield* isClosed) {
        const n = yield* dayHead(day)
        if (Option.isSome(n)) return n.value
      }
      yield* Effect.sleep(START_POLL)
    }
  })

  // One block's pages at `size`: each page's valid rows of the day inside
  // [B - 3 min, B) go up as one batch. Answers how many pages it took.
  const walkBlock = Effect.fnUntraced(function* (
    day: WibDate,
    windowEnd: DateTime.Utc,
    boundary: number,
    size: number
  ) {
    const from = boundary - BLOCK
    for (let page = 1; ; page++) {
      const { size: answered, rows } = yield* tapePage(
        windowEnd,
        yield* tapePath(boundary, page, size)
      )
      const kept = yield* blockRows(day, from, boundary, rows)
      if (kept.length > 0) yield* post({ day, rows: kept })
      if (size === PAGE_SIZE) {
        fetched += kept.length
        yield* trades(fetched, dayN)
      }
      const older = rows.some((row) => row.timestamp < from)
      if (answered < size || older || page >= MAX_PAGES) return page
    }
  })

  // The first pass starts at the boundary just after the day's last trade
  // could be, or just after now if that is earlier.
  const firstBoundary = Effect.fnUntraced(function* (day: WibDate) {
    const now = yield* Clock.currentTimeMillis
    const end = DateTime.toEpochMillis(yield* streamingEndOf(day))
    return Math.floor(Math.min(now, end) / BLOCK) * BLOCK + BLOCK
  })

  // The first pass, block by block from the kept position back to 08:45,
  // noting each block that took 2+ pages. Answers the repair pass's start.
  const firstPass = Effect.fnUntraced(function* (
    windowEnd: DateTime.Utc,
    from: AjaibWalkPosition
  ) {
    const dayStart = Date.parse(`${from.day}T08:45:00+07:00`)
    let position = from
    while (position.next > dayStart) {
      const boundary = position.next
      const pages = yield* walkBlock(from.day, windowEnd, boundary, PAGE_SIZE)
      position = {
        ...position,
        next: boundary - BLOCK,
        repair: pages >= 2 ? [...position.repair, boundary] : position.repair,
      }
      yield* store.save(position)
    }
    const repair: AjaibWalkPosition = { ...position, pass: "repair" }
    yield* store.save(repair)
    return repair
  })

  // The repair pass: each noted block again at 4,999 rows a page.
  const repairPass = Effect.fnUntraced(function* (
    windowEnd: DateTime.Utc,
    from: AjaibWalkPosition
  ) {
    let position = from
    for (const boundary of from.repair) {
      yield* walkBlock(from.day, windowEnd, boundary, REPAIR_PAGE_SIZE)
      position = { ...position, repair: position.repair.slice(1) }
      yield* store.save(position)
    }
    return position
  })

  const walkDay = Effect.fnUntraced(function* (day: WibDate) {
    const windowEnd = yield* ajaibWindowEnd(day)
    if (Option.isNone(windowEnd))
      return yield* halt({ _tag: "unserved", reason: "window-passed" })
    yield* guard(windowEnd.value)
    const held = Option.filter(yield* store.load, (kept) => kept.day === day)
    if (Option.isSome(held) && held.value.pass === "done")
      return { _tag: "walked" } satisfies WalkResult
    const n = yield* awaitClose(day, windowEnd.value)
    fetched = 0
    dayN = Option.some(Number(n))
    let position: AjaibWalkPosition = Option.isSome(held)
      ? held.value
      : { day, pass: "first", next: yield* firstBoundary(day), repair: [] }
    if (position.pass === "first")
      position = yield* firstPass(windowEnd.value, position)
    position = yield* repairPass(windowEnd.value, position)
    yield* post({ day, rows: [], end: { n } })
    yield* store.save({ ...position, pass: "done" })
    return { _tag: "walked" } satisfies WalkResult
  })

  const walk = (day: WibDate): Effect.Effect<WalkResult> => settle(walkDay(day))

  return { walk }
})
