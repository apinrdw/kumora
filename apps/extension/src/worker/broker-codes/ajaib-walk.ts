// Ajaib's walk of the newest closed day (spec apinrdw/kumora#244, "The
// extension: the Ajaib walk"; apinrdw/kumora#707): the day's whole REST tape
// under one fixed `last_timestamp`, in two passes of large pages. Each
// page's rows with valid codes are posted to Production in batches of at
// most BATCH_ROWS, each with its fields when they are valid; `end` follows
// the second pass. Production's walk keeps each trade it posts with a stock
// code for the Done Details walk (done-details-walk.ts).
import {
  AjaibTradeNum,
  BATCH_ROWS,
  BrokerCodesProtocolVersion,
  StockCode,
  WibDate,
  ajaibRowCodes,
  ajaibRowFields,
  ajaibSequence,
  batchRow,
  type BatchRow,
  type BrokerCodesBatch,
  type TradeCodes,
  type TradeFields,
  type TradeNumber,
} from "@workspace/relay"
import type { DateTime } from "effect"
import { Clock, Effect, Option, Schema } from "effect"

import type { Answer } from "../broker.ts"
import { START_POLL, makeAjaibCalls, type AjaibWalkTab } from "./ajaib-calls.ts"
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

// Decision: the tape walk pages the whole day at 50,000 then 49,999 rows
// (apps/extension/docs/adr/0024-the-ajaib-tape-walk-pages-the-whole-day.md)
const PASS_SIZES = { first: 50_000, second: 49_999 } as const
// `last_timestamp` filters on a hidden time, not the row's own, so it is no
// cursor: one value past the day's last trade serves the whole walk.
const AHEAD = 60 * 60_000
// 100 pages of 50,000 is 5,000,000 trades, past any IDX day; a tape that
// keeps answering past this is not paging.
const MAX_PAGES = 100
// The first call, whose newest row gives the day's highest trade number.
const HEAD_PAGE_SIZE = 40

// Where a day's walk stands, kept after each page so a restarted worker
// carries on: the pass, the page it asks next, the walk's fixed
// `last_timestamp` (epoch ms), which a resumed walk keeps so its pages line
// up with those before the restart, and the trades posted so far, for the
// options page. It also holds what the first pass posted: the tape offset
// it reached, and the offsets before it whose row it didn't post (one it
// couldn't read, one without valid codes), other than another day's. The
// first pass adds to them page by page; the second reads them as the first
// left them, to post only the trades the first pass didn't. A walk's state is its
// position alone, so a restart at any page loses none of it. A position
// kept mid-walk in an older shape doesn't decode, so the day is walked
// afresh.
// Decision: the tape walk pages the whole day at 50,000 then 49,999 rows
// (apps/extension/docs/adr/0024-the-ajaib-tape-walk-pages-the-whole-day.md)
const Walking = Schema.Struct({
  day: WibDate,
  pass: Schema.Literals(["first", "second"]),
  page: Schema.Finite,
  lastTimestamp: Schema.Finite,
  fetched: Schema.Finite,
  reached: Schema.Finite,
  missed: Schema.Array(Schema.Finite),
})
type Walking = typeof Walking.Type
export const AjaibWalkPosition = Schema.Union([
  Walking,
  Schema.Struct({ day: WibDate, pass: Schema.Literal("done") }),
])
export type AjaibWalkPosition = typeof AjaibWalkPosition.Type

// Whether the first pass didn't post the tape's row at `offset`: one its
// page boundaries skipped, one past where it reached, or one it read but
// didn't post. In the first pass, every row counts.
const SPAN = PASS_SIZES.first + 1
const firstMissed = (position: Walking) => {
  if (position.pass === "first") return () => true
  const missed = new Set(position.missed)
  return (offset: number) =>
    (offset + 1) % SPAN === 0 ||
    offset >= position.reached ||
    missed.has(offset)
}

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
  Schema.Struct({
    results: Schema.Array(Schema.Unknown),
    has_next: Schema.optionalKey(Schema.Boolean),
  })
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
  // Its place on its page, from 0.
  readonly at: number
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
  // False once the tape says no page follows; true when it doesn't say.
  readonly hasNext: boolean
  readonly rows: ReadonlyArray<PageRow>
}

// A page's rows that carry a trade number and a time; a row without either
// is skipped, so its trade counts as missing.
const pageRows = Effect.fnUntraced(function* (answer: Answer) {
  const page = decodePage(answer.body)
  if (Option.isNone(page)) return Option.none<TapeAnswer>()
  const rows: Array<PageRow> = []
  for (const [at, raw] of page.value.results.entries()) {
    const row = decodeRow(raw)
    if (Option.isNone(row)) continue
    rows.push({
      at,
      date: row.value.date,
      timestamp: row.value.timestamp,
      number: yield* ajaibSequence(row.value.trade_num),
      code: Option.map(decodeRowCode(raw), (valid) => valid.stock_code),
      codes: yield* ajaibRowCodes(raw),
      fields: yield* ajaibRowFields(raw),
    })
  }
  return Option.some<TapeAnswer>({
    size: page.value.results.length,
    hasNext: page.value.has_next ?? true,
    rows,
  })
})

// The batch rows of `rows` on `day` with valid codes, their places on the
// page, and each row on `day` with a stock code as the Done Details walk
// keeps it: with its key when its codes and fields are valid, else unkeyed.
const dayRows = Effect.fnUntraced(function* (
  day: WibDate,
  rows: ReadonlyArray<PageRow>
) {
  const batch: Array<BatchRow> = []
  const posted = new Set<number>()
  const kept: Array<TapeTrade> = []
  for (const row of rows) {
    if (row.date !== day || row.number === "0") continue
    if (Option.isSome(row.codes)) {
      batch.push(yield* batchRow(row.number, row.codes.value, row.fields))
      posted.add(row.at)
    }
    if (Option.isSome(row.codes) && Option.isSome(row.fields))
      kept.push(yield* keptTrade(row.number, row.codes.value, row.fields.value))
    else if (Option.isSome(row.code))
      kept.push({ _tag: "Unkeyed", number: row.number, code: row.code.value })
  }
  return { batch, posted, kept }
})

// The tape offsets of a first-pass page's rows it didn't post, other than
// another day's: a row it couldn't read counts, as one without valid codes.
const unposted = (
  day: WibDate,
  answer: TapeAnswer,
  posted: ReadonlySet<number>,
  start: number
) => {
  const otherDay = new Set(
    answer.rows.filter((row) => row.date !== day).map((row) => row.at)
  )
  const offsets: Array<number> = []
  for (let at = 0; at < answer.size; at++)
    if (!posted.has(at) && !otherDay.has(at)) offsets.push(start + at)
  return offsets
}

export const makeAjaibWalk = Effect.fnUntraced(function* (options: {
  readonly tab: AjaibWalkTab
  readonly post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
  readonly store: AjaibWalkStore
  // For the options page (progress.ts): the trades the walk has posted of
  // the day's N.
  readonly trades?: (
    fetched: number,
    of: Option.Option<number>
  ) => Effect.Effect<void>
  // For the options page too: what the walk is doing, and since when.
  readonly phase?: (phase: WalkPhase) => Effect.Effect<void>
  // Keeps each page's trades for the Done Details walk, once the page's
  // batches went up (done-details-walk.ts).
  readonly keep?: (
    day: WibDate,
    trades: ReadonlyArray<TapeTrade>
  ) => Effect.Effect<void>
}) {
  const { tab, store } = options
  const keep = options.keep ?? (() => Effect.void)
  const trades = options.trades ?? (() => Effect.void)
  const report = options.phase ?? (() => Effect.void)
  const { enter, guard, call, readPage } = yield* makeAjaibCalls(tab, report)

  // One tape page, retried in place until it answers one.
  const tapePage = (windowEnd: DateTime.Utc, path: string) =>
    readPage(windowEnd, path, pageRows)

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
      Option.exists(
        decodeStatus(answer.body),
        (decoded) =>
          ("result" in decoded ? decoded.result.status : decoded.status) ===
          "CLOSED"
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
    const page =
      head.status === 200 ? yield* pageRows(head) : Option.none<never>()
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

  // One pass of the day's pages under the walk's fixed `last_timestamp`,
  // from the kept page on. Each page's rows go up in batches of at most
  // BATCH_ROWS, Production's batch limit, and its next page is kept. A pass
  // ends at a page that answers fewer rows than asked, or that the tape
  // says none follows. It answers the position past its last page.
  // Decision: the tape walk pages the whole day at 50,000 then 49,999 rows
  // (apps/extension/docs/adr/0024-the-ajaib-tape-walk-pages-the-whole-day.md)
  const walkPass = Effect.fnUntraced(function* (
    windowEnd: DateTime.Utc,
    n: number,
    from: Walking
  ) {
    const { day, pass, lastTimestamp } = from
    const size = PASS_SIZES[pass]
    const missed = firstMissed(from)
    let position = from
    while (position.page <= MAX_PAGES) {
      const here = position
      const { page } = here
      const answer = yield* tapePage(
        windowEnd,
        yield* tapePath(lastTimestamp, page, size)
      )
      const start = (page - 1) * (size + 1)
      const rows = answer.rows.filter((row) => missed(start + row.at))
      const { batch, posted, kept } = yield* dayRows(day, rows)
      // Decision: a batch holds at most 5,000 rows, read up to BROKER_CODES_BATCH_LIMIT
      // (packages/relay/docs/adr/0012-a-broker-codes-batch-fits-one-byte-limit-on-both-sides.md)
      for (let at = 0; at < batch.length; at += BATCH_ROWS)
        yield* post({ day, rows: batch.slice(at, at + BATCH_ROWS) })
      // Kept once posted, so a restart between the two posts the page again.
      if (kept.length > 0) yield* keep(day, kept)
      position = {
        ...here,
        page: page + 1,
        fetched: here.fetched + batch.length,
        ...(pass === "first"
          ? {
              reached: start + answer.size,
              missed: [...here.missed, ...unposted(day, answer, posted, start)],
            }
          : {}),
      }
      yield* trades(position.fetched, Option.some(n))
      if (answer.size < size || !answer.hasNext) break
      yield* store.save(position)
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
    let position: Walking =
      Option.isSome(held) && held.value.pass !== "done"
        ? held.value
        : {
            day,
            pass: "first",
            page: 1,
            lastTimestamp: (yield* Clock.currentTimeMillis) + AHEAD,
            fetched: 0,
            reached: 0,
            missed: [],
          }
    yield* trades(position.fetched, Option.some(Number(n)))
    if (position.pass === "first") {
      const first = yield* walkPass(windowEnd, Number(n), position)
      position = { ...first, pass: "second", page: 1 }
      yield* store.save(position)
    }
    yield* walkPass(windowEnd, Number(n), position)
    yield* post({ day, rows: [], end: { n } })
    yield* store.save({ day, pass: "done" })
    return { _tag: "walked" } satisfies WalkResult
  })

  const walk = (day: WibDate): Effect.Effect<WalkResult> => settle(walkDay(day))

  return { walk }
})
