// What the row budgets measure (tests/server/market-live/row-budgets.workerd.test.ts),
// each by name. The worker starts a trading day on the busy day, as a woken
// object does, runs `before` uncounted, then counts the rows `measure`'s
// statements read and wrote. A new budget adds its operation here.
import {
  BrokerCode,
  BrokerCodesProtocolVersion,
  TradeNumber,
  WibDate,
  encodeBrokerCodesBatch,
  type BrokerCodesBatch,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { WorkerEnv } from "@workspace/server"

import type { makeTradingDay } from "../src/server/market-live/trading-day.ts"

type TradingDay = Effect.Success<ReturnType<typeof makeTradingDay>>

export interface Operation {
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

// A full Ajaib batch of 5,000 rows, without fields, that changes every
// trade's buyer from 100,001 on: each of its trades had its codes indexed
// on both sides.
const BATCH_FROM = 100_001
const correctingBatch: BrokerCodesBatch = {
  version: BrokerCodesProtocolVersion,
  feed: "Ajaib",
  day: WibDate.make("2026-11-09"),
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

const batchPost = (day: TradingDay) =>
  Effect.flatMap(encodeBrokerCodesBatch(correctingBatch), day.brokerCodes.post)

export const operations = {
  "status pass": { measure: statusPass },
  // An object that answered a status since it woke, so it knows whether its
  // codes are complete.
  "recorded codes GET": { before: statusPass, measure: codesGet },
  "recorded codes GET, freshly started": { measure: codesGet },
  "correcting batch": { measure: batchPost },
} satisfies Record<string, Operation>

export type OperationName = keyof typeof operations
