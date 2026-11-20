// Ajaib's Done Details walk of the newest closed day (spec
// apinrdw/kumora#627, "Slice 4"): after the tape walk, each code's
// `broker-transaction` rows give each trade's buy and sell order numbers,
// matched to the trades the tape walk kept by (code, second, board, price,
// lots, buyer, seller). Stockbit's walk fills what it leaves.
import {
  Board,
  BrokerCodesProtocolVersion,
  StockCode,
  TradeCodes,
  TradeNumber,
  ajaibDetailOrderNumbers,
  batchRow,
  type BatchRow,
  type BrokerCodesBatch,
  type TradeFields,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Option, Schema } from "effect"

import { RETRY, makeAjaibCalls, type AjaibWalkTab } from "./ajaib-calls.ts"
import { ajaibWindowEnd } from "./hours.ts"
import type { PostOutcome } from "./poster.ts"
import {
  haltOnRefusal,
  settle,
  type WalkPhase,
  type WalkResult,
} from "./run-queue.ts"

const DETAILS_PATH = "v1/stock/data/broker-transaction"
// Decision: 1,000 rows a page, the most Ajaib serves: 1,001 gets a
// Cloudflare 403. The window 00:00 to 23:59:59 holds the pre-opening, the
// auctions and the negotiated board after the close. See
// apinrdw/kumora#622.
const PAGE_SIZE = 1_000
// A batch's most rows (BATCH_ROWS in @workspace/relay).
const BATCH_ROWS = 5_000

// A trade the tape walk kept for this walk to match: its number and codes,
// and the fields its key reads, its time as the WIB second `HH:mm:ss`.
export const KeptTrade = Schema.Struct({
  number: TradeNumber,
  code: StockCode,
  second: Schema.String,
  board: Board,
  price: Schema.Finite,
  lots: Schema.Finite,
  codes: TradeCodes,
})
export type KeptTrade = typeof KeptTrade.Type

// One Done Details row as the walk keeps it between pages: its key and the
// trade's buy and sell order numbers.
export const DetailRow = Schema.Struct({
  key: Schema.String,
  buy: Schema.Finite,
  sell: Schema.Finite,
})
export type DetailRow = typeof DetailRow.Type

// The page the walk asks next, of a code the kept trades hold.
export const DoneDetailsPosition = Schema.Struct({
  code: StockCode,
  page: Schema.Finite,
})
export type DoneDetailsPosition = typeof DoneDetailsPosition.Type

// What the walk keeps across a worker restart, for one day at a time
// (settings.ts keeps it in IndexedDB).
export interface DoneDetailsStore {
  // Keeps the tape walk's trades of `day`, forgetting any other day's.
  readonly keep: (
    day: WibDate,
    trades: ReadonlyArray<KeptTrade>
  ) => Effect.Effect<void>
  // The codes `day`'s kept trades hold, in order; none for another day.
  readonly codes: (day: WibDate) => Effect.Effect<ReadonlyArray<StockCode>>
  readonly trades: (
    day: WibDate,
    code: StockCode
  ) => Effect.Effect<ReadonlyArray<KeptTrade>>
  // Where the walk of `day` stands; none before its first page.
  readonly position: (
    day: WibDate
  ) => Effect.Effect<Option.Option<DoneDetailsPosition>>
  // The rows of `code` fetched before its position's page.
  readonly rows: (
    day: WibDate,
    code: StockCode
  ) => Effect.Effect<ReadonlyArray<DetailRow>>
  // Moves the walk to `next`, with the rows of `next.code` the page before
  // it gave; another code's rows are forgotten. One write, so a restart
  // never holds a page's rows twice.
  readonly page: (
    day: WibDate,
    next: DoneDetailsPosition,
    rows: ReadonlyArray<DetailRow>
  ) => Effect.Effect<void>
  // Forgets everything: the walk of the day has ended.
  readonly clear: Effect.Effect<void>
}

// Decision: the rows are `result.transactions`, paged while
// `result.has_next`, as Ajaib's web app reads them
// (docs/research/ajaib-post-close-broker-codes.md on branch
// research/order-number-routes).
const DetailsPage = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      has_next: Schema.Boolean,
      transactions: Schema.Array(Schema.Unknown),
    }),
  })
)
// What the key reads of a row. `time` is `HH:mm:ss`, or `HH:mm` for the
// 08:58 and 16:00 auctions.
const DetailKeyRow = Schema.Struct({
  time: Schema.String.check(Schema.isPattern(/^\d\d:\d\d(:\d\d)?$/)),
  code: StockCode,
  board: Board,
  price: Schema.Finite,
  qty: Schema.Finite,
  buyer: Schema.Struct({ broker_code: Schema.String }),
  seller: Schema.Struct({ broker_code: Schema.String }),
})
const decodePage = Schema.decodeUnknownOption(DetailsPage)
const decodeKeyRow = Schema.decodeUnknownOption(DetailKeyRow)

const keyOf = (fields: {
  readonly code: string
  readonly second: string
  readonly board: string
  readonly price: number
  readonly lots: number
  readonly buyer: string
  readonly seller: string
}) =>
  Effect.succeed(
    [
      fields.code,
      fields.second,
      fields.board,
      fields.price,
      fields.lots,
      fields.buyer,
      fields.seller,
    ].join(" ")
  )

const WIB_OFFSET_MS = 7 * 3_600_000

// The tape walk's trade as this walk keeps it.
export const keptTrade = (
  number: TradeNumber,
  codes: TradeCodes,
  fields: TradeFields
) =>
  Effect.sync((): KeptTrade => ({
    number,
    code: fields.code,
    second: new Date(DateTime.toEpochMillis(fields.time) + WIB_OFFSET_MS)
      .toISOString()
      .slice(11, 19),
    board: fields.board,
    price: fields.price,
    lots: fields.lots,
    codes,
  }))

// A page's rows of `day` with a key and both order numbers; a row without
// either matches no trade.
const detailRows = Effect.fnUntraced(function* (
  day: WibDate,
  transactions: ReadonlyArray<unknown>
) {
  const rows: Array<DetailRow> = []
  for (const raw of transactions) {
    const row = decodeKeyRow(raw)
    const orders = yield* ajaibDetailOrderNumbers(day, raw)
    if (Option.isNone(row) || Option.isNone(orders)) continue
    const { time, code, board, price, qty, buyer, seller } = row.value
    rows.push({
      key: yield* keyOf({
        code,
        second: time.length === 5 ? `${time}:00` : time,
        board,
        price,
        lots: qty,
        buyer: buyer.broker_code,
        seller: seller.broker_code,
      }),
      buy: orders.value[0],
      sell: orders.value[1],
    })
  }
  return rows
})

// Decision: a key whose rows and kept trades are as many gives the rows'
// order numbers to its trades in any order: tied trades share second,
// price, lots and both brokers, so no order run's orders change. A key
// whose counts differ, or a row with no trade, gives nothing. See
// apinrdw/kumora#622.
const matched = Effect.fnUntraced(function* (
  trades: ReadonlyArray<KeptTrade>,
  rows: ReadonlyArray<DetailRow>
) {
  const byKey = new Map<string, Array<DetailRow>>()
  for (const row of rows)
    byKey.set(row.key, [...(byKey.get(row.key) ?? []), row])
  const tradesByKey = new Map<string, Array<KeptTrade>>()
  for (const trade of trades) {
    const key = yield* keyOf({
      ...trade,
      buyer: trade.codes.buyer,
      seller: trade.codes.seller,
    })
    tradesByKey.set(key, [...(tradesByKey.get(key) ?? []), trade])
  }
  const batch: Array<BatchRow> = []
  for (const [key, tied] of tradesByKey) {
    const found = byKey.get(key) ?? []
    if (found.length !== tied.length) continue
    for (const [at, trade] of tied.entries()) {
      const row = found[at]!
      batch.push(
        yield* batchRow(
          trade.number,
          trade.codes,
          Option.none(),
          Option.some([row.buy, row.sell] as const)
        )
      )
    }
  }
  return batch
})

const detailsPath = (day: WibDate, code: StockCode, page: number) =>
  Effect.succeed(
    `${DETAILS_PATH}?code=${code}&group=BS&type=TRADE&market_date=${day}&start_time=00:00&end_time=23:59:59&page=${page}&page_size=${PAGE_SIZE}`
  )

export const makeDoneDetailsWalk = Effect.fnUntraced(function* (options: {
  readonly tab: AjaibWalkTab
  readonly post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
  readonly store: DoneDetailsStore
  // For the options page (progress.ts): the codes walked, of the day's.
  readonly codes?: (done: number, of: number) => Effect.Effect<void>
  // For the options page too: what the walk is doing, and since when.
  readonly phase?: (phase: WalkPhase) => Effect.Effect<void>
}) {
  const { store } = options
  const codesDone = options.codes ?? (() => Effect.void)
  const { enter, guard, call } = yield* makeAjaibCalls(
    options.tab,
    options.phase ?? (() => Effect.void)
  )

  // One page, retried in place until it answers one.
  const detailsPage = Effect.fnUntraced(function* (
    windowEnd: DateTime.Utc,
    path: string
  ) {
    while (true) {
      yield* guard(windowEnd)
      const answer = yield* call(windowEnd, path)
      if (Option.isSome(answer) && answer.value.status === 200) {
        const page = decodePage(answer.value.body)
        if (Option.isSome(page)) return page.value.result
      }
      yield* Effect.sleep(RETRY)
    }
  })

  const post = Effect.fnUntraced(function* (
    day: WibDate,
    rows: ReadonlyArray<BatchRow>
  ) {
    for (let at = 0; at < rows.length; at += BATCH_ROWS) {
      const outcome = yield* options.post({
        version: BrokerCodesProtocolVersion,
        feed: "Ajaib",
        day,
        rows: rows.slice(at, at + BATCH_ROWS),
      })
      if (outcome !== "sent") return yield* haltOnRefusal(outcome)
    }
  })

  // One code's pages from `page` on, then its matched trades posted.
  const walkCode = Effect.fnUntraced(function* (
    day: WibDate,
    windowEnd: DateTime.Utc,
    code: StockCode,
    from: number
  ) {
    for (let page = from; ; page++) {
      const answer = yield* detailsPage(
        windowEnd,
        yield* detailsPath(day, code, page)
      )
      const rows = yield* detailRows(day, answer.transactions)
      if (answer.has_next && answer.transactions.length > 0) {
        yield* store.page(day, { code, page: page + 1 }, rows)
        continue
      }
      const all = [...(yield* store.rows(day, code)), ...rows]
      return yield* post(
        day,
        yield* matched(yield* store.trades(day, code), all)
      )
    }
  })

  const walkDay = Effect.fnUntraced(function* (day: WibDate) {
    const codes = yield* store.codes(day)
    // A day this browser didn't tape-walk from Ajaib, or one whose walk
    // ended, has no kept trades.
    if (codes.length === 0) return { _tag: "walked" } satisfies WalkResult
    const windowEnd = yield* ajaibWindowEnd(day)
    yield* guard(windowEnd)
    yield* enter("fetching")
    const held = yield* store.position(day)
    const start = Option.match(held, {
      onNone: () => 0,
      onSome: ({ code }) => Math.max(0, codes.indexOf(code)),
    })
    for (let at = start; at < codes.length; at++) {
      const code = codes[at]!
      yield* codesDone(at, codes.length)
      const page = Option.match(held, {
        onNone: () => 1,
        onSome: (position) => (position.code === code ? position.page : 1),
      })
      yield* walkCode(day, windowEnd, code, page)
      const next = codes[at + 1]
      if (next !== undefined)
        yield* store.page(day, { code: next, page: 1 }, [])
    }
    yield* codesDone(codes.length, codes.length)
    yield* store.clear
    return { _tag: "walked" } satisfies WalkResult
  })

  // Past Ajaib's window the walk has ended too, and its kept trades go.
  const walk = (day: WibDate): Effect.Effect<WalkResult> =>
    Effect.tap(settle(walkDay(day)), (result) =>
      result._tag === "unserved" ? store.clear : Effect.void
    )

  return { walk }
})
