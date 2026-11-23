// Ajaib's walk of the newest closed day (spec apinrdw/kumora#244, "The
// extension: the Ajaib walk"): the day's REST tape, one 3-minute block at a
// time, then a repair pass over every block that took 2+ pages. Each page's
// rows with valid codes are posted to Production as one batch, each with its
// fields when they are valid; `end` follows the repair. Production's walk
// keeps each trade it reads with a stock code for the Done Details walk
// (done-details-walk.ts).
import {
  AjaibTradeNum,
  BrokerCodesProtocolVersion,
  StockCode,
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
import {
  RETRY,
  START_POLL,
  makeAjaibCalls,
  type AjaibWalkTab,
} from "./ajaib-calls.ts"
import { keptTrade, type TapeTrade } from "./done-details-walk.ts"
import { ajaibWindowEnd } from "./hours.ts"
import type { PostOutcome } from "./poster.ts"
import {
  haltOnRefusal,
  settle,
  type WalkPhase,
  type WalkResult,
} from "./run-queue.ts"

const STATUS_PATH = "v1/stock/data/trading-day/time/"
const TAPE_PATH = "v1/stock/detail/running_trades/"

// The tape floors `last_timestamp` to a 3-minute WIB boundary and
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

// `trading-day/time/`'s market status is read from `result.status`,
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
// A row's stock code, read apart from its other fields so a trade whose
// fields aren't valid is still kept as its code's (done-details-walk.ts).
const RowCode = Schema.Struct({ stock_code: StockCode })
const decodeStatus = Schema.decodeUnknownOption(MarketStatus)
const decodePage = Schema.decodeUnknownOption(TapePage)
const decodeRow = Schema.decodeUnknownOption(TapeRow)
const decodeRowCode = Schema.decodeUnknownOption(RowCode)

const tapePath = (lastTimestamp: number, page: number, size: number) =>
  Effect.succeed(
    `${TAPE_PATH}?last_timestamp=${lastTimestamp}&direction=DESC&page=${page}&page_size=${size}`
  )

interface PageRow {
  readonly date: WibDate
  readonly timestamp: number
  readonly number: TradeNumber
  readonly code: Option.Option<StockCode>
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
      code: Option.map(decodeRowCode(raw), (valid) => valid.stock_code),
      codes: yield* ajaibRowCodes(raw),
      fields: yield* ajaibRowFields(raw),
    })
  }
  return Option.some<TapeAnswer>({ size: page.value.results.length, rows })
})

// The batch rows of `rows` on `day` inside [from, boundary) with valid
// codes, and each of them with a stock code as the Done Details walk keeps
// it: with its key when its codes and fields are valid, else unkeyed.
const blockRows = Effect.fnUntraced(function* (
  day: WibDate,
  from: number,
  boundary: number,
  rows: ReadonlyArray<PageRow>
) {
  const batch: Array<BatchRow> = []
  const kept: Array<TapeTrade> = []
  for (const row of rows) {
    const inBlock =
      row.date === day &&
      row.timestamp >= from &&
      row.timestamp < boundary &&
      row.number !== "0"
    if (!inBlock) continue
    if (Option.isSome(row.codes))
      batch.push(yield* batchRow(row.number, row.codes.value, row.fields))
    if (Option.isSome(row.codes) && Option.isSome(row.fields))
      kept.push(yield* keptTrade(row.number, row.codes.value, row.fields.value))
    else if (Option.isSome(row.code))
      kept.push({ _tag: "Unkeyed", number: row.number, code: row.code.value })
  }
  return { batch, kept }
})

export const makeAjaibWalk = Effect.fnUntraced(function* (options: {
  readonly tab: AjaibWalkTab
  readonly post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
  readonly store: AjaibWalkStore
  // For the options page (progress.ts): the trades the first pass fetched
  // since the walk started, of the day's N.
  readonly trades?: (
    fetched: number,
    of: Option.Option<number>
  ) => Effect.Effect<void>
  // For the options page too: the blocks the repair pass has walked again
  // since the walk started, of those it then had left.
  readonly repaired?: (done: number, of: number) => Effect.Effect<void>
  // For the options page too: what the walk is doing, and since when.
  readonly phase?: (phase: WalkPhase) => Effect.Effect<void>
  // Keeps each page's trades for the Done Details walk, before the page's
  // batch goes up (done-details-walk.ts).
  readonly keep?: (
    day: WibDate,
    trades: ReadonlyArray<TapeTrade>
  ) => Effect.Effect<void>
}) {
  const { tab, store } = options
  const keep = options.keep ?? (() => Effect.void)
  const trades = options.trades ?? (() => Effect.void)
  const repaired = options.repaired ?? (() => Effect.void)
  const report = options.phase ?? (() => Effect.void)
  const { enter, guard, call } = yield* makeAjaibCalls(tab, report)
  let fetched = 0
  let dayN = Option.none<number>()

  // One tape page, retried in place until it answers one.
  const tapePage = Effect.fnUntraced(function* (
    windowEnd: DateTime.Utc,
    path: string
  ) {
    while (true) {
      yield* guard(windowEnd)
      const answer = yield* call(windowEnd, path)
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

  const isClosed = (windowEnd: DateTime.Utc) =>
    Effect.map(call(windowEnd, STATUS_PATH), (answer) =>
      Option.exists(answer, (status) =>
        Option.exists(
          decodeStatus(status.body),
          (decoded) =>
            ("result" in decoded ? decoded.result.status : decoded.status) ===
            "CLOSED"
        )
      )
    )

  // The day's highest trade number, once the tape's newest page is the
  // day's and carries codes on every row.
  const dayHead = Effect.fnUntraced(function* (
    day: WibDate,
    windowEnd: DateTime.Utc
  ) {
    const now = yield* Clock.currentTimeMillis
    const head = yield* call(windowEnd, yield* tapePath(now, 1, HEAD_PAGE_SIZE))
    if (Option.isNone(head)) return Option.none<TradeNumber>()
    const page =
      head.value.status === 200
        ? yield* pageRows(head.value)
        : Option.none<never>()
    // An empty page, a page of another date, or rows without codes are
    // polled again until the window ends (ajaibWindowEnd in hours.ts).
    const rows = Option.match(page, {
      onNone: (): ReadonlyArray<PageRow> => [],
      onSome: (answer) => answer.rows,
    })
    const newest = rows[0]
    if (newest === undefined) return Option.none<TradeNumber>()
    if (newest.date !== day) return Option.none<TradeNumber>()
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
    yield* enter("awaiting-close")
    while (true) {
      yield* guard(windowEnd)
      if (yield* isClosed(windowEnd)) {
        const n = yield* dayHead(day, windowEnd)
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
      const { batch, kept } = yield* blockRows(day, from, boundary, rows)
      if (kept.length > 0) yield* keep(day, kept)
      if (batch.length > 0) yield* post({ day, rows: batch })
      if (size === PAGE_SIZE) {
        fetched += batch.length
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
    const of = from.repair.length
    if (of > 0) yield* repaired(0, of)
    for (const [at, boundary] of from.repair.entries()) {
      yield* walkBlock(from.day, windowEnd, boundary, REPAIR_PAGE_SIZE)
      position = { ...position, repair: position.repair.slice(1) }
      yield* store.save(position)
      yield* repaired(at + 1, of)
    }
    return position
  })

  const walkDay = Effect.fnUntraced(function* (day: WibDate) {
    const windowEnd = yield* ajaibWindowEnd(day)
    yield* guard(windowEnd)
    const held = Option.filter(yield* store.load, (kept) => kept.day === day)
    if (Option.isSome(held) && held.value.pass === "done")
      return { _tag: "walked" } satisfies WalkResult
    const n = yield* awaitClose(day, windowEnd)
    yield* enter("fetching")
    fetched = 0
    dayN = Option.some(Number(n))
    let position: AjaibWalkPosition = Option.isSome(held)
      ? held.value
      : { day, pass: "first", next: yield* firstBoundary(day), repair: [] }
    if (position.pass === "first")
      position = yield* firstPass(windowEnd, position)
    position = yield* repairPass(windowEnd, position)
    yield* post({ day, rows: [], end: { n } })
    yield* store.save({ ...position, pass: "done" })
    return { _tag: "walked" } satisfies WalkResult
  })

  const walk = (day: WibDate): Effect.Effect<WalkResult> => settle(walkDay(day))

  return { walk }
})
