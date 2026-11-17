// Seeds the Test stage's broker totals (the BrokerTotalsDb local D1) as
// trading-day builds would leave them, for the stock page's Broker inventory
// tab, which only reads them.
import { isTradingDay } from "@workspace/relay"
import { Effect } from "effect"

import { BROKER_TOTALS_VERSION } from "../../dashboard/src/server/broker-totals/version.ts"

import { marketNow, wibDate } from "./clock"
import { replaceTables } from "./local-d1"

const DAY = 86_400_000

/** One broker's lots bought and sold on a day. */
export interface SeededFlow {
  readonly broker: string
  readonly investorType: "D" | "F"
  readonly buyLots: number
  readonly sellLots: number
}

/** A built day's flows in one stock code, at one price. */
export interface SeededDay {
  readonly day: string
  readonly price: number
  readonly flows: ReadonlyArray<SeededFlow>
  /** The trades of the day its build missed; none by default. */
  readonly missingTrades?: number
}

/**
 * The `count` trading days before today on the Test stage's Market Live
 * clock, oldest first. Today stays unbuilt, so the tab notes it pending.
 */
export function tradingDaysBeforeToday(count: number): ReadonlyArray<string> {
  const days: Array<string> = []
  for (let back = 1; days.length < count; back++) {
    const day = wibDate(marketNow() - back * DAY)
    if (Effect.runSync(isTradingDay(day))) days.unshift(day)
  }
  return days
}

/** Replaces every built day with `days`, each `code`'s. */
export function seedBrokerTotals(code: string, days: ReadonlyArray<SeededDay>) {
  replaceTables("BrokerTotalsDb", ["totals", "candles", "built_days"], (db) => {
    const total = db.prepare(
      "INSERT INTO totals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    const candle = db.prepare(
      "INSERT INTO candles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    const built = db.prepare(
      "INSERT INTO built_days VALUES (?, ?, '2026-11-14T10:00:00.000Z', ?)"
    )
    for (const { day, price, flows, missingTrades = 0 } of days) {
      // A lot is 100 shares.
      const value = (lots: number) => lots * 100 * price
      // One trade every 5 lots.
      const trades = (lots: number) => Math.ceil(lots / 5)
      let volume = 0
      for (const { broker, investorType, buyLots, sellLots } of flows) {
        total.run(
          code,
          day,
          broker,
          investorType,
          buyLots,
          value(buyLots),
          sellLots,
          value(sellLots),
          trades(buyLots),
          trades(sellLots)
        )
        volume += buyLots
      }
      candle.run(
        code,
        day,
        price,
        price,
        price,
        price,
        volume,
        value(volume),
        trades(volume)
      )
      built.run(day, BROKER_TOTALS_VERSION, missingTrades)
    }
  })
}
