// Ajaib's Done Details walk of the newest closed day (spec
// apinrdw/kumora#627, "Slice 4"): after the tape walk, each code's
// `broker-transaction` rows give each trade's buy and sell order numbers,
// matched to the trades the tape walk kept by (code, second, board, price,
// lots, buyer, seller). Stockbit's walk fills what it leaves.
import {
  BATCH_ROWS,
  Board,
  BrokerCode,
  BrokerCodesProtocolVersion,
  OrderNumber,
  Side,
  StockCode,
  TradeCodes,
  TradeNumber,
  WIB_UTC_OFFSET_HOURS,
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

// A trade the tape walk kept for this walk to match: its number and codes,
// and the fields its key reads, its time as the WIB second `HH:mm:ss`, and
// its aggressor side.
export const KeptTrade = Schema.Struct({
  number: TradeNumber,
  code: StockCode,
  second: Schema.String,
  board: Board,
  price: Schema.Finite,
  lots: Schema.Finite,
  side: Side,
  codes: TradeCodes,
})
export type KeptTrade = typeof KeptTrade.Type

// One Done Details row as the walk keeps it between pages: its key and the
// trade's buy and sell order numbers.
export const DetailRow = Schema.Struct({
  key: Schema.String,
  buy: OrderNumber,
  sell: OrderNumber,
})
export type DetailRow = typeof DetailRow.Type

// A kept trade given its Done Details row's order numbers, held until the
// walk posts it.
export const MatchedTrade = Schema.Struct({
  number: TradeNumber,
  codes: TradeCodes,
  buy: OrderNumber,
  sell: OrderNumber,
})
export type MatchedTrade = typeof MatchedTrade.Type

// Where the walk of a day stands: at the page it asks next, of a code the
// kept trades hold; past the last code, posting the matched trades; or
// done, its matched trades held for the extra target's catch-up.
export const DoneDetailsPosition = Schema.Union([
  Schema.TaggedStruct("Walking", { code: StockCode, page: Schema.Finite }),
  Schema.TaggedStruct("Posting", {}),
  Schema.TaggedStruct("Posted", {}),
])
export type DoneDetailsPosition = typeof DoneDetailsPosition.Type
const POSTING: DoneDetailsPosition = { _tag: "Posting" }
const POSTED: DoneDetailsPosition = { _tag: "Posted" }

// What the walk keeps across a worker restart, for one day at a time
// (done-details-store.ts keeps it in IndexedDB).
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
  // never holds a page's rows twice. At Posted the kept trades are
  // forgotten too, and the matched ones stay.
  readonly page: (
    day: WibDate,
    next: DoneDetailsPosition,
    rows: ReadonlyArray<DetailRow>
  ) => Effect.Effect<void>
  // Holds a code's matched trades of `day`; holding one again changes
  // nothing.
  readonly match: (
    day: WibDate,
    trades: ReadonlyArray<MatchedTrade>
  ) => Effect.Effect<void>
  // The first `limit` matched trades of `day` numbered above `after`, in
  // trade order.
  readonly matched: (
    day: WibDate,
    after: number,
    limit: number
  ) => Effect.Effect<ReadonlyArray<MatchedTrade>>
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
  buyer: Schema.Struct({ broker_code: BrokerCode }),
  seller: Schema.Struct({ broker_code: BrokerCode }),
})
const decodePage = Schema.decodeUnknownOption(DetailsPage)
const decodeKeyRow = Schema.decodeUnknownOption(DetailKeyRow)

const keyOf = (fields: {
  readonly code: StockCode
  readonly second: string
  readonly board: typeof Board.Type
  readonly price: number
  readonly lots: number
  readonly buyer: BrokerCode
  readonly seller: BrokerCode
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

// The tape walk's trade as this walk keeps it.
export const keptTrade = (
  number: TradeNumber,
  codes: TradeCodes,
  fields: TradeFields
) =>
  Effect.sync((): KeptTrade => ({
    number,
    code: fields.code,
    second: DateTime.formatIso(
      DateTime.add(fields.time, { hours: WIB_UTC_OFFSET_HOURS })
    ).slice(11, 19),
    board: fields.board,
    price: fields.price,
    lots: fields.lots,
    side: fields.side,
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

// The lane a trade or row pairs in: its key and its aggressor side. A row's
// side is its order pair's later order's, the larger number's; every row
// also lies in its key's sideless lane, where an auction match's trades,
// which have no side, find it.
const lane = (key: string, side: KeptTrade["side"]) =>
  Effect.succeed(`${key} ${side}`)
const rowLanes = Effect.fnUntraced(function* (rows: ReadonlyArray<DetailRow>) {
  const lanes = new Map<string, Array<DetailRow>>()
  for (const row of rows)
    for (const side of ["none", row.buy > row.sell ? "buy" : "sell"] as const) {
      const at = yield* lane(row.key, side)
      lanes.set(at, [...(lanes.get(at) ?? []), row])
    }
  return lanes
})

// The kept trades by lane, leaving out a key's sideless trades when it has
// trades with a side too: its rows can't be told apart between them.
const tradeLanes = Effect.fnUntraced(function* (
  trades: ReadonlyArray<KeptTrade>
) {
  const lanes = new Map<string, Array<KeptTrade>>()
  const sided = new Set<string>()
  const sideless: Array<readonly [string, KeptTrade]> = []
  for (const trade of trades) {
    const key = yield* keyOf({
      ...trade,
      buyer: trade.codes.buyer,
      seller: trade.codes.seller,
    })
    if (trade.side === "none") {
      sideless.push([key, trade])
      continue
    }
    sided.add(key)
    const at = yield* lane(key, trade.side)
    lanes.set(at, [...(lanes.get(at) ?? []), trade])
  }
  for (const [key, trade] of sideless) {
    if (sided.has(key)) continue
    const at = yield* lane(key, "none")
    lanes.set(at, [...(lanes.get(at) ?? []), trade])
  }
  return lanes
})

// Decision: rows and kept trades pair within a lane, one key's one side: a
// buy trade takes the rows whose buy order is the larger, a sell trade the
// rows whose sell order is. A lane whose rows and trades are as many gives
// the rows' order numbers to its trades in any order: tied trades of one
// side share second, price, lots and both brokers, so no order run's orders
// change, while ties across sides would swap aggressor and passive orders.
// A lane whose counts differ, or a row with no trade, gives nothing. See
// apinrdw/kumora#622.
const matched = Effect.fnUntraced(function* (
  trades: ReadonlyArray<KeptTrade>,
  rows: ReadonlyArray<DetailRow>
) {
  const byLane = yield* rowLanes(rows)
  const found: Array<MatchedTrade> = []
  for (const [at, tied] of yield* tradeLanes(trades)) {
    const laneRows = byLane.get(at) ?? []
    if (laneRows.length !== tied.length) continue
    for (const [index, { number, codes }] of tied.entries()) {
      const { buy, sell } = laneRows[index]!
      found.push({ number, codes, buy, sell })
    }
  }
  return found
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

  // Decision: the matched trades are held (in IndexedDB) until the last
  // code is walked, then posted in trade order, BATCH_ROWS a batch. Trade
  // numbers run in time order, so each batch spans a minute or two of the
  // market, as the Stockbit walk's do, and the dashboard's sweep brokers
  // recompute, which regroups the whole market's minute for each minute a
  // batch touches, reads each minute about once. Posting each code as it
  // ended touched every minute the code traded in, once per code: 800
  // codes regrouped a busy day's 1.46 M trades some 800 times over. A
  // dashboard that coalesced recomputes across batches would break its rule
  // that a batch's sweep brokers rows are written before its 200. See
  // apinrdw/kumora#627, "Slice 4".
  const postMatched = Effect.fnUntraced(function* (
    day: WibDate,
    post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
  ) {
    for (let after = 0; ;) {
      const trades = yield* store.matched(day, after, BATCH_ROWS)
      const last = trades.at(-1)
      if (last === undefined) return
      const rows: Array<BatchRow> = []
      for (const { number, codes, buy, sell } of trades)
        rows.push(
          yield* batchRow(
            number,
            codes,
            Option.none(),
            Option.some([buy, sell] as const)
          )
        )
      const outcome = yield* post({
        version: BrokerCodesProtocolVersion,
        feed: "Ajaib",
        day,
        rows,
      })
      if (outcome !== "sent") return yield* haltOnRefusal(outcome)
      after = Number(last.number)
    }
  })

  // One code's pages from `page` on, then its matched trades held.
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
        yield* store.page(day, { _tag: "Walking", code, page: page + 1 }, rows)
        continue
      }
      const all = [...(yield* store.rows(day, code)), ...rows]
      return yield* store.match(
        day,
        yield* matched(yield* store.trades(day, code), all)
      )
    }
  })

  // Every kept code's pages from the held position on, then on to posting.
  const walkCodes = Effect.fnUntraced(function* (
    day: WibDate,
    codes: ReadonlyArray<StockCode>,
    held: Option.Option<DoneDetailsPosition>
  ) {
    const windowEnd = yield* ajaibWindowEnd(day)
    yield* guard(windowEnd)
    yield* enter("fetching")
    const walking = Option.flatMap(held, (position) =>
      position._tag === "Walking" ? Option.some(position) : Option.none()
    )
    const start = Option.match(walking, {
      onNone: () => 0,
      onSome: ({ code }) => Math.max(0, codes.indexOf(code)),
    })
    for (let at = start; at < codes.length; at++) {
      const code = codes[at]!
      yield* codesDone(at, codes.length)
      const page = Option.match(walking, {
        onNone: () => 1,
        onSome: (position) => (position.code === code ? position.page : 1),
      })
      yield* walkCode(day, windowEnd, code, page)
      const next = codes[at + 1]
      yield* store.page(
        day,
        next === undefined ? POSTING : { _tag: "Walking", code: next, page: 1 },
        []
      )
    }
    yield* codesDone(codes.length, codes.length)
  })

  const walkDay = Effect.fnUntraced(function* (day: WibDate) {
    const walked = { _tag: "walked" } satisfies WalkResult
    const held = yield* store.position(day)
    const step = Option.map(held, (position) => position._tag)
    if (Option.contains(step, "Posted")) return walked
    if (!Option.contains(step, "Posting")) {
      const codes = yield* store.codes(day)
      // A day this browser didn't tape-walk from Ajaib, or one whose walk
      // ended, has no kept trades.
      if (codes.length === 0) return walked
      yield* walkCodes(day, codes, held)
    }
    yield* postMatched(day, options.post)
    yield* store.page(day, POSTED, [])
    return walked
  })

  // Past Ajaib's window the walk has ended too, and its kept trades go.
  const walk = (day: WibDate): Effect.Effect<WalkResult> =>
    Effect.tap(settle(walkDay(day)), (result) =>
      result._tag === "unserved" ? store.clear : Effect.void
    )

  // The extra target's catch-up (extra-target.ts): the matched trades of
  // `day` posted again, once the walk has posted them to Production.
  const resend = (
    day: WibDate,
    post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
  ): Effect.Effect<WalkResult> =>
    settle(
      Effect.gen(function* () {
        const held = yield* store.position(day)
        if (Option.exists(held, (position) => position._tag === "Posted"))
          yield* postMatched(day, post)
        return { _tag: "walked" } satisfies WalkResult
      })
    )

  return { walk, resend }
})
