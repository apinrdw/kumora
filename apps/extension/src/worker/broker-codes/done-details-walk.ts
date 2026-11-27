// Ajaib's Done Details walk of the newest closed day (spec
// apinrdw/kumora#627, "Slice 4"): after the tape walk, each code's
// `broker-transaction` rows give each trade's buy and sell order numbers,
// matched to the trades the tape walk kept by every field both report
// (`MatchFields`). Stockbit's walk fills what it leaves.
import {
  BATCH_ROWS,
  Board,
  BrokerCode,
  BrokerCodesProtocolVersion,
  InvestorType,
  OrderNumber,
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

import { makeAjaibCalls, type AjaibWalkTab } from "./ajaib-calls.ts"
import { ajaibWindowEnd } from "./hours.ts"
import type { PostOutcome } from "./poster.ts"
import {
  haltOnRefusal,
  settle,
  type WalkPhase,
  type WalkResult,
} from "./run-queue.ts"
import type { StallRecord } from "./stall-records.ts"

const DETAILS_PATH = "v1/stock/data/broker-transaction"
// 1,000 rows a page, the most Ajaib serves: 1,001 gets a
// Cloudflare 403. The window 00:00 to 23:59:59 holds the pre-opening, the
// auctions and the negotiated board after the close. See
// apinrdw/kumora#622.
const PAGE_SIZE = 1_000

// A trade the tape walk kept for this walk to match: its number and codes,
// and the fields its key reads, its time as the WIB second `HH:mm:ss`.
const KeptTrade = Schema.TaggedStruct("Kept", {
  number: TradeNumber,
  code: StockCode,
  second: Schema.String,
  board: Board,
  price: Schema.Finite,
  lots: Schema.Finite,
  codes: TradeCodes,
})
export type KeptTrade = typeof KeptTrade.Type
// A trade the tape walk read with its stock code but not its broker codes
// or fields, so it has no key.
const UnkeyedTrade = Schema.TaggedStruct("Unkeyed", {
  number: TradeNumber,
  code: StockCode,
})
// Each trade the tape walk read with its stock code, as it keeps them.
export const TapeTrade = Schema.Union([KeptTrade, UnkeyedTrade])
export type TapeTrade = typeof TapeTrade.Type

// The fields a Done Details row and a kept trade both report for a trade,
// which a pair agrees on. Not the side: the tape's and the order numbers'
// disagree in the auctions, which have no aggressor.
const MatchFields = Schema.Struct({
  code: StockCode,
  second: Schema.String,
  board: Board,
  price: Schema.Finite,
  lots: Schema.Finite,
  buyer: BrokerCode,
  buyerType: InvestorType,
  seller: BrokerCode,
  sellerType: InvestorType,
})
type MatchFields = typeof MatchFields.Type

// One Done Details row as the walk keeps it between pages: its fields and
// the trade's buy and sell order numbers, or that it couldn't be read.
const ReadRow = Schema.TaggedStruct("Read", {
  fields: MatchFields,
  buy: OrderNumber,
  sell: OrderNumber,
})
type ReadRow = typeof ReadRow.Type
export const DetailRow = Schema.Union([
  ReadRow,
  Schema.TaggedStruct("Unread", {}),
])
export type DetailRow = typeof DetailRow.Type
const UNREAD: DetailRow = { _tag: "Unread" }

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
// tape trades hold; past the last code, posting the matched trades; or
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
  // Keeps the tape walk's trades of `day`, forgetting any other day's. An
  // unkeyed trade never replaces one kept with its key.
  readonly keep: (
    day: WibDate,
    trades: ReadonlyArray<TapeTrade>
  ) => Effect.Effect<void>
  // The codes `day`'s tape trades hold, in order; none for another day.
  readonly codes: (day: WibDate) => Effect.Effect<ReadonlyArray<StockCode>>
  readonly trades: (
    day: WibDate,
    code: StockCode
  ) => Effect.Effect<ReadonlyArray<TapeTrade>>
  // Where the walk of `day` stands; none before its first page.
  readonly position: (
    day: WibDate
  ) => Effect.Effect<Option.Option<DoneDetailsPosition>>
  // The rows of `code` fetched before its position's page, in the order
  // Ajaib answered them.
  readonly rows: (
    day: WibDate,
    code: StockCode
  ) => Effect.Effect<ReadonlyArray<DetailRow>>
  // Moves the walk to `next`, with the rows of `next.code` the page before
  // it gave; another code's rows are forgotten. One write, so a restart
  // never holds a page's rows twice. At Posted the tape trades are
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

// The rows are `result.transactions`, paged while
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
// The fields a row reports for its trade. `time` is `HH:mm:ss`, or `HH:mm`
// for the 08:58 and 16:00 auctions; each side's `type` is its investor
// type.
const DetailKeyRow = Schema.Struct({
  time: Schema.String.check(Schema.isPattern(/^\d\d:\d\d(:\d\d)?$/)),
  code: StockCode,
  board: Board,
  price: Schema.Finite,
  qty: Schema.Finite,
  buyer: Schema.Struct({ broker_code: BrokerCode, type: InvestorType }),
  seller: Schema.Struct({ broker_code: BrokerCode, type: InvestorType }),
})
const decodePage = Schema.decodeUnknownOption(DetailsPage)
const decodeKeyRow = Schema.decodeUnknownOption(DetailKeyRow)

// The key a trade and a row pair under: every one of `MatchFields`, read
// from the struct's own list, so none can be left out. The second pass's
// key leaves out the lots.
const MATCH_FIELDS = Object.keys(MatchFields.fields) as ReadonlyArray<
  keyof MatchFields
>
const NO_LOT_FIELDS = MATCH_FIELDS.filter((name) => name !== "lots")
const keyOf = (fields: MatchFields) =>
  Effect.sync(() => JSON.stringify(MATCH_FIELDS.map((name) => fields[name])))
const noLotKeyOf = (fields: MatchFields) =>
  Effect.sync(() => JSON.stringify(NO_LOT_FIELDS.map((name) => fields[name])))

// The tape walk's trade as this walk keeps it.
export const keptTrade = (
  number: TradeNumber,
  codes: TradeCodes,
  fields: TradeFields
) =>
  Effect.sync((): KeptTrade => ({
    _tag: "Kept",
    number,
    code: fields.code,
    second: DateTime.formatIso(
      DateTime.add(fields.time, { hours: WIB_UTC_OFFSET_HOURS })
    ).slice(11, 19),
    board: fields.board,
    price: fields.price,
    lots: fields.lots,
    codes,
  }))

// A page's rows of `day` with their fields and both order numbers, or
// unread without either.
const detailRows = Effect.fnUntraced(function* (
  day: WibDate,
  transactions: ReadonlyArray<unknown>
) {
  const rows: Array<DetailRow> = []
  for (const raw of transactions) {
    const row = decodeKeyRow(raw)
    const orders = yield* ajaibDetailOrderNumbers(day, raw)
    if (Option.isNone(row) || Option.isNone(orders)) {
      rows.push(UNREAD)
      continue
    }
    const { time, code, board, price, qty, buyer, seller } = row.value
    const [buy, sell] = orders.value
    rows.push({
      _tag: "Read",
      fields: {
        code,
        second: time.length === 5 ? `${time}:00` : time,
        board,
        price,
        lots: qty,
        buyer: buyer.broker_code,
        buyerType: buyer.type,
        seller: seller.broker_code,
        sellerType: seller.type,
      },
      buy,
      sell,
    })
  }
  return rows
})

// A kept trade's fields, as its Done Details row reports them.
const tradeFields = (trade: KeptTrade) =>
  Effect.succeed<MatchFields>({
    code: trade.code,
    second: trade.second,
    board: trade.board,
    price: trade.price,
    lots: trade.lots,
    buyer: trade.codes.buyer,
    buyerType: trade.codes.buyerType,
    seller: trade.codes.seller,
    sellerType: trade.codes.sellerType,
  })

// The rows, each once: Ajaib can list a trade's row twice, alike in every
// field and both order numbers.
const distinct = (rows: ReadonlyArray<ReadRow>) =>
  Effect.sync(() => {
    const seen = new Set<string>()
    return rows.filter((row) => {
      const at = JSON.stringify([
        ...MATCH_FIELDS.map((name) => row.fields[name]),
        row.buy,
        row.sell,
      ])
      if (seen.has(at)) return false
      seen.add(at)
      return true
    })
  })

// One pass: each of `rows`, in Ajaib's order, takes the highest-numbered
// trade left of its key, and the rows and trades still unpaired are left
// for the next.
const pairByRowOrder = Effect.fnUntraced(function* (
  rows: ReadonlyArray<ReadRow>,
  trades: ReadonlyArray<KeptTrade>,
  key: (fields: MatchFields) => Effect.Effect<string>
) {
  const left = new Map<string, Array<KeptTrade>>()
  const inTradeOrder = [...trades].sort(
    (a, b) => Number(a.number) - Number(b.number)
  )
  for (const trade of inTradeOrder) {
    const at = yield* key(yield* tradeFields(trade))
    const group = left.get(at) ?? []
    group.push(trade)
    left.set(at, group)
  }
  const found: Array<MatchedTrade> = []
  const unpaired: Array<ReadRow> = []
  for (const row of rows) {
    const trade = left.get(yield* key(row.fields))?.pop()
    if (trade === undefined) {
      unpaired.push(row)
      continue
    }
    found.push({
      number: trade.number,
      codes: trade.codes,
      buy: row.buy,
      sell: row.sell,
    })
  }
  return { found, rows: unpaired, trades: [...left.values()].flat() }
})

// Decision: rows pair with trades in Ajaib's row order, by a key with no side
// (apps/extension/docs/adr/0026-done-details-rows-pair-with-trades-in-ajaib-s-row-order.md)
//
// Ajaib answers a code's rows newest first, so each takes the newest trade
// left of its key. A second pass leaves out the lots, for the NG trades
// whose fractional lot reads 0 in Done Details and 1 on the tape. A code
// with a row the walk can't read gets nothing: that row could be any key's,
// and every pairing of its key after it would shift by one.
const matched = Effect.fnUntraced(function* (
  record: ReadonlyArray<TapeTrade>,
  rows: ReadonlyArray<DetailRow>
) {
  const trades = record.flatMap((trade) =>
    trade._tag === "Kept" ? [trade] : []
  )
  const readRows = rows.flatMap((row) => (row._tag === "Read" ? [row] : []))
  if (readRows.length < rows.length) return []
  const first = yield* pairByRowOrder(yield* distinct(readRows), trades, keyOf)
  const second = yield* pairByRowOrder(first.rows, first.trades, noLotKeyOf)
  return [...first.found, ...second.found]
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
  // Keeps each stall's record for Copy diagnostics (stall-records.ts).
  readonly stalls?: (record: StallRecord) => Effect.Effect<void>
}) {
  const { store } = options
  const codesDone = options.codes ?? (() => Effect.void)
  const { enter, locate, guard, readPage } = yield* makeAjaibCalls(
    options.tab,
    options.phase ?? (() => Effect.void),
    { walk: "done-details", record: options.stalls }
  )

  // One page, retried in place until it answers one.
  const detailsPage = (windowEnd: DateTime.Utc, path: string) =>
    readPage(windowEnd, path, (answer) =>
      Effect.succeed(Option.map(decodePage(answer.body), (page) => page.result))
    )

  // Decision: matched trades post after the last code, in trade order
  // (apps/extension/docs/adr/0005-matched-trades-post-after-the-last-code-in-trade-order.md)
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
      yield* locate({ day, code, page })
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
      // ended, has no tape trades.
      if (codes.length === 0) return walked
      yield* walkCodes(day, codes, held)
    }
    yield* postMatched(day, options.post)
    yield* store.page(day, POSTED, [])
    return walked
  })

  // Past Ajaib's window the walk has ended too, and its tape trades go.
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
