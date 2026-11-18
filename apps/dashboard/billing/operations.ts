// What the row budgets measure (tests/server/market-live/row-budgets.workerd.test.ts),
// each by name. The worker starts a trading day on the busy day, as a woken
// object does, runs `before` uncounted, then counts the rows `measure`'s
// statements read and wrote. A new budget adds its operation here.
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  TradeNumber,
  encodeBrokerCodesBatch,
  type BrokerCodesBatch,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { WorkerEnv } from "@workspace/server"

import type { makeTradingDay } from "../src/server/market-live/trading-day.ts"
import { BUSY_DAY, busyCodes } from "./busy-figures.ts"

type TradingDay = Effect.Success<ReturnType<typeof makeTradingDay>>

export interface Operation {
  // Whether the object has a broker totals DB, which a batch's buildable
  // check runs for. The operation never reaches it: a build runs on the alarm.
  readonly brokerTotals?: boolean
  // What the object did since it woke, before the count starts.
  readonly before?: (
    day: TradingDay
  ) => Effect.Effect<unknown, unknown, WorkerEnv>
  readonly measure: (
    day: TradingDay
  ) => Effect.Effect<Response, unknown, WorkerEnv>
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

export const operations = {
  "status pass": { measure: statusPass },
  // An object that answered a status since it woke, so it knows whether its
  // codes are complete.
  "recorded codes GET": { before: statusPass, measure: codesGet },
  "recorded codes GET, freshly started": { measure: codesGet },
  // Writes its chunks: its budget gets a busy day of its own.
  "resent batch": { brokerTotals: true, measure: resentPost },
  "correcting batch": { measure: correctingPost },
} satisfies Record<string, Operation>

export type OperationName = keyof typeof operations
