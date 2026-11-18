// What the row budgets measure (tests/server/market-live/row-budgets.workerd.test.ts),
// each by name. The worker starts a trading day on the busy day, as a woken
// object does, runs `before` uncounted, then counts the rows `measure`'s
// statements read and wrote. A new budget adds its operation here.
import { DateTime, type Effect } from "effect"

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

export const operations = {
  "status pass": { measure: statusPass },
  // An object that answered a status since it woke, so it knows whether its
  // codes are complete.
  "recorded codes GET": { before: statusPass, measure: codesGet },
  "recorded codes GET, freshly started": { measure: codesGet },
} satisfies Record<string, Operation>

export type OperationName = keyof typeof operations
