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
  // The first `limit` matched trades of `day` numbered above `after`, or
  // from the first without it, in trade order.
  readonly matched: (
    day: WibDate,
    after: Option.Option<TradeNumber>,
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

// The side group a trade or row pairs in: its key and its aggressor side.
// A row's side is its order pair's later order's, the larger number's;
// every row also lies in its key's sideless group, where an auction match's
// trades, which have no side, find it.
const sideGroup = (key: string, side: KeptTrade["side"]) =>
  Effect.succeed(`${key} ${side}`)
const rowGroups = Effect.fnUntraced(function* (rows: ReadonlyArray<DetailRow>) {
  const groups = new Map<string, Array<DetailRow>>()
  for (const row of rows)
    for (const side of ["none", row.buy > row.sell ? "buy" : "sell"] as const) {
      const at = yield* sideGroup(row.key, side)
      groups.set(at, [...(groups.get(at) ?? []), row])
    }
  return groups
})

// The kept trades by side group, leaving out a key's sideless trades when
// it has trades with a side too: its rows can't be told apart between them.
const tradeGroups = Effect.fnUntraced(function* (
  trades: ReadonlyArray<KeptTrade>
) {
  const groups = new Map<string, Array<KeptTrade>>()
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
    const at = yield* sideGroup(key, trade.side)
    groups.set(at, [...(groups.get(at) ?? []), trade])
  }
  for (const [key, trade] of sideless) {
    if (sided.has(key)) continue
    const at = yield* sideGroup(key, "none")
    groups.set(at, [...(groups.get(at) ?? []), trade])
  }
  return groups
})

// Whether `tied` are one run of the code's kept trades: none of `trades`
// lies between them in trade order.
const oneRun = (
  trades: ReadonlyArray<KeptTrade>,
  tied: ReadonlyArray<KeptTrade>
) =>
  Effect.sync(() => {
    const numbers = tied.map(({ number }) => Number(number))
    const first = Math.min(...numbers)
    const last = Math.max(...numbers)
    return trades.every(({ number }) => {
      const n = Number(number)
      return n < first || n > last || numbers.includes(n)
    })
  })

// A side group's rows in order of their aggressor orders, the larger of
// each row's pair, then of their passive orders.
const byAggressor = (rows: ReadonlyArray<DetailRow>) =>
  Effect.sync(() =>
    rows.toSorted(
      (a, b) =>
        Math.max(a.buy, a.sell) - Math.max(b.buy, b.sell) ||
        Math.min(a.buy, a.sell) - Math.min(b.buy, b.sell)
    )
  )

// Decision: a side group (one key's one side) gives its rows' order numbers
// to its kept trades only when they are as many and the trades are one run,
// no other kept trade of the code between them in trade order. A run is one
// aggressor broker's part of one whole sweep, so which tied trade takes
// which row changes no order run; they take the rows in trade order and
// aggressor order alike. Tied trades another trade splits may be two whole
// sweeps the key can't tell apart: they get nothing, nor does a group whose
// counts differ, and Stockbit's walk, which reads trade numbers, gives
// theirs. A trade the tape walk kept no fields for is unseen between them.
// See apinrdw/kumora#622 and #632.
const matched = Effect.fnUntraced(function* (
  trades: ReadonlyArray<KeptTrade>,
  rows: ReadonlyArray<DetailRow>
) {
  const byGroup = yield* rowGroups(rows)
  const found: Array<MatchedTrade> = []
  for (const [at, tied] of yield* tradeGroups(trades)) {
    const groupRows = byGroup.get(at) ?? []
    if (groupRows.length !== tied.length || !(yield* oneRun(trades, tied)))
      continue
    const inOrder = yield* byAggressor(groupRows)
    const tradesInOrder = tied.toSorted(
      (a, b) => Number(a.number) - Number(b.number)
    )
    for (const [index, { number, codes }] of tradesInOrder.entries()) {
      const { buy, sell } = inOrder[index]!
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

  // Decision: matched trades are held until the last code is walked, then
  // posted in trade order, BATCH_ROWS a batch, so each batch spans a minute
  // or two and the dashboard's sweep brokers recompute regroups each market
  // minute about once, not once per code. Coalescing on the dashboard would
  // write rows after a batch's 200. See apinrdw/kumora#632.
  const postMatched = Effect.fnUntraced(function* (
    day: WibDate,
    post: (batch: BrokerCodesBatch) => Effect.Effect<PostOutcome>
  ) {
    for (let after = Option.none<TradeNumber>(); ;) {
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
      after = Option.some(last.number)
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
