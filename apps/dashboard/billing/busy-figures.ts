// The busy day's figures (billing/busy-day.ts builds it): its date, size,
// holes and the codes it holds, apart from the builder so the row budgets'
// operations can read them without the Durable Object types.
import { BrokerCode, WibDate, type TradeCodes } from "@workspace/relay"

// Decision: Production's busiest measured day, 1,460,000 trades
// (docs/runbooks/order-flow-cost.md, "The estimate model"), over 800 codes
// from 09:00 to 16:15 WIB. The relay missed a few trades, which a walk
// filled as walk_trades rows: the status reads around them, as on a real day.
export const BUSY_DAY = {
  date: WibDate.make("2026-11-09"),
  trades: 1_460_000,
  codes: 800,
  holes: [12_345, 404_040, 777_777, 1_000_001, 1_333_333],
} as const

export const BROKERS = [
  "AK",
  "BK",
  "CC",
  "DX",
  "KZ",
  "MG",
  "PD",
  "YP",
  "ZP",
  "RX",
]
const buyerOf = (number: number) => BROKERS[(number * 7) % BROKERS.length]!
const sellerOf = (number: number) => BROKERS[(number * 3) % BROKERS.length]!
const typeOf = (number: number): TradeCodes["buyerType"] =>
  number % 5 === 0 ? "F" : "D"

// The codes the busy day holds for trade `number`.
export const busyCodes = (number: number): TradeCodes => ({
  buyer: BrokerCode.make(buyerOf(number)),
  buyerType: typeOf(number),
  seller: BrokerCode.make(sellerOf(number)),
  sellerType: typeOf(number + 1),
})
