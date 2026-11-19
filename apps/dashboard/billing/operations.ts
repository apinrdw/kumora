// What the row budgets measure (tests/server/market-live/row-budgets.workerd.test.ts),
// each by name. The worker starts a trading day on the busy day, as a woken
// object does, runs `before` uncounted, then counts the rows `measure`'s
// statements read and wrote. A new budget adds its operation here.
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  StockCode,
  TradeNumber,
  encodeBrokerCodesBatch,
  type BrokerCodesBatch,
  type RunningTrade,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { WorkerEnv } from "@workspace/server"

import { makeDayStore, type Sql } from "../src/server/market-live/day-store.ts"
import type { makeTradingDay } from "../src/server/market-live/trading-day.ts"
import { BUSY_DAY, busyCodes } from "./busy-figures.ts"

type TradingDay = Effect.Success<ReturnType<typeof makeTradingDay>>

export interface Operation {
  // What the worker makes of the busy day before the object wakes: a day
  // sealed before the tape summary, with none, a walk day before its seal,
  // or a day batched before the codes-complete fact, without it. The busy
  // day as built otherwise.
  readonly stored?:
    | "sealed before the summary"
    | "walking"
    | "batched before the codes-complete fact"
  // Whether the object has a broker totals DB, which a batch's buildable
  // check runs for. The operation never reaches it: a build runs on the alarm.
  readonly brokerTotals?: boolean
  // Whether the day moves to R2: to a bucket in the worker's memory, its
  // object emptied by a measured deleteAll() (worker.ts), at midnight ten
  // trading days after it.
  readonly moves?: boolean
  // What the object did since it woke, before the count starts.
  readonly before?: (
    day: TradingDay
  ) => Effect.Effect<unknown, unknown, WorkerEnv>
  readonly measure: (
    day: TradingDay,
    sql: Sql,
    moving: Moving
  ) => Effect.Effect<Response, unknown, WorkerEnv>
}

// What a moving day's deleteAll() billed, once it ran: its rows as the
// adapter counts them, the rows its tables held and its bytes before and
// after.
interface Moving {
  readonly emptied: Effect.Effect<Record<string, number> | undefined>
}

// Every trade's broker codes status, as the extension's status GET asks it.
const statusPass = (day: TradingDay) =>
  day.brokerCodes.status(new URLSearchParams())

// The page's codes answer for the tape's last 200 trades of the day.
const codesGet = (day: TradingDay) =>
  day.recorded({
    _tag: "BrokerCodes",
    at: DateTime.makeUnsafe("2026-11-09T16:15:00+07:00"),
  })

// The page's tape answer: the day's last 200 trades, and a page of 200
// further back, below a trade number at midday.
const tapeGet = (day: TradingDay) =>
  day.recorded({
    _tag: "Tape",
    at: DateTime.makeUnsafe("2026-11-09T16:15:00+07:00"),
  })
const tapePage = (day: TradingDay) =>
  day.recorded({
    _tag: "Tape",
    at: DateTime.makeUnsafe("2026-11-09T12:00:00+07:00"),
    before: TradeNumber.make("700000"),
  })

// The trading day's own flush adds candles and footprints to the same
// transaction; the trade chunks are what this measures.
// Decision: a live flush on the busy day writes a minute at its mean rate,
// 1,460,000 over 435 minutes, past its tape's last, and the trades its relay
// missed arriving late, each in a chunk of its own: 4 chunks for the minute
// and 1 for each late trade. A peak minute (~30 K trades) writes ~31 chunk
// rows, over the spec's ~20, which follows from 1,000-trade chunks.
const FLUSHED = { first: BUSY_DAY.trades + 1, rows: 3_356 }

const flushTrade = (number: number): RunningTrade => ({
  tradeNumber: TradeNumber.make(String(number)),
  time: DateTime.makeUnsafe("2026-11-09T16:15:30+07:00"),
  code: StockCode.make(`C${number % BUSY_DAY.codes}`),
  price: 1_000,
  lots: 1,
  side: "buy",
  board: "RG",
  feeds: ["Stockbit"],
})

const liveFlush = (_day: TradingDay, sql: Sql) =>
  Effect.gen(function* () {
    const store = yield* makeDayStore(sql, { today: true })
    yield* store.write({
      trades: [
        ...BUSY_DAY.holes.map(flushTrade),
        ...Array.from({ length: FLUSHED.rows }, (_, at) =>
          flushTrade(FLUSHED.first + at)
        ),
      ],
      candles: [],
      footprints: [],
      livePrices: [],
      chunks: [],
      ajaibBooks: [],
      facts: {},
    })
    return new Response("flushed")
  })

// Decision: a full Ajaib page, 5,000 trades, resent with the codes the day
// holds, as a walk over a sealed day sends them: it changes no codes, so
// it costs its chunks and its checks, `buildable`'s status pass and
// `completed`, which reads what that pass kept.
const RESENT = { first: 700_001, rows: 5_000 }

// A resent Ajaib batch, posted as the extension posts it.
const resentPost = (day: TradingDay) =>
  Effect.gen(function* () {
    const text = yield* encodeBrokerCodesBatch({
      version: BrokerCodesProtocolVersion,
      feed: "Ajaib",
      day: BUSY_DAY.date,
      rows: Array.from({ length: RESENT.rows }, (_, at) => {
        const number = RESENT.first + at
        return [TradeNumber.make(String(number)), busyCodes(number)] as const
      }),
    })
    return yield* day.brokerCodes.post(text)
  })

// Decision: a walk day's full Ajaib page, 5,000 trades the tape lacks
// with their fields, past its last: it fills the tape, so it costs its tape
// and summary writes, its chunks, and its checks, `walkSealDue`'s status
// pass and `completed`.
const WALKED = { first: BUSY_DAY.trades + 1, rows: 5_000 }

// A walk day's next Ajaib batch, posted as the extension posts it.
const walkPost = (day: TradingDay) =>
  Effect.gen(function* () {
    const time = DateTime.makeUnsafe("2026-11-09T16:14:00+07:00")
    const text = yield* encodeBrokerCodesBatch({
      version: BrokerCodesProtocolVersion,
      feed: "Ajaib",
      day: BUSY_DAY.date,
      rows: Array.from({ length: WALKED.rows }, (_, at) => {
        const number = WALKED.first + at
        return [
          TradeNumber.make(String(number)),
          busyCodes(number),
          {
            time,
            code: StockCode.make(`C${number % BUSY_DAY.codes}`),
            price: 1_000,
            lots: 1,
            board: "RG",
            side: "buy",
          },
        ] as const
      }),
    })
    return yield* day.brokerCodes.post(text)
  })

// A full Ajaib batch of 5,000 rows, without fields, that changes every
// trade's buyer from 100,001 on: each of its trades had its codes indexed
// on both sides.
const BATCH_FROM = 100_001
const correctingBatch: BrokerCodesBatch = {
  version: BrokerCodesProtocolVersion,
  feed: "Ajaib",
  day: BUSY_DAY.date,
  rows: Array.from({ length: 5_000 }, (_, index) => [
    TradeNumber.make(String(BATCH_FROM + index)),
    {
      buyer: BrokerCode.make("XA"),
      buyerType: "D",
      seller: BrokerCode.make("YP"),
      sellerType: "F",
    },
  ]),
}

const correctingPost = (day: TradingDay) =>
  Effect.flatMap(encodeBrokerCodesBatch(correctingBatch), day.brokerCodes.post)

// The busy code's heatmap, worked out from its book chunks.
const heatmapGet = (day: TradingDay) =>
  day.recorded({ _tag: "Heatmap", code: StockCode.make(BUSY_DAY.bookCode) })

// The busy day asked to move, and its alarm run until its move emptied it:
// answers what deleteAll() billed and how many alarm runs the move took.
const moveWhole = (day: TradingDay, _sql: Sql, moving: Moving) =>
  Effect.gen(function* () {
    if (!(yield* day.move)) return new Response("Not due", { status: 409 })
    for (let runs = 1; runs <= 100; runs++) {
      yield* day.alarm
      const emptied = yield* moving.emptied
      if (emptied !== undefined) return Response.json({ runs, ...emptied })
    }
    return new Response("Not moved", { status: 500 })
  })

export const operations = {
  "status pass": { measure: statusPass },
  // An object that answered a status since it woke, so it knows whether its
  // codes are complete.
  "recorded codes GET": { before: statusPass, measure: codesGet },
  "recorded codes GET, freshly started": { measure: codesGet },
  // Its GET writes the codes-complete fact: it gets a busy day of its own.
  "recorded codes GET, batched before the codes-complete fact": {
    stored: "batched before the codes-complete fact",
    measure: codesGet,
  },
  // Writes its chunks: its budget gets a busy day of its own.
  "resent batch": { brokerTotals: true, measure: resentPost },
  "correcting batch": { measure: correctingPost },
  // Its first status pass builds the summary; the second is measured.
  "status pass after the summary's build": {
    stored: "sealed before the summary",
    before: statusPass,
    measure: statusPass,
  },
  "walk batch": { stored: "walking", measure: walkPost },
  "recorded tape GET": { measure: tapeGet },
  "recorded tape page": { measure: tapePage },
  // Writes trades: its budget gets a busy day of its own.
  "live flush": { measure: liveFlush },
  "heatmap GET": { measure: heatmapGet },
  // Empties the object: its budget gets a busy day of its own.
  move: { moves: true, measure: moveWhole },
} satisfies Record<string, Operation>

export type OperationName = keyof typeof operations
