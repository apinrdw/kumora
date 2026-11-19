// The busy day's figures (billing/busy-day.ts builds it): its date, size,
// holes and the codes it holds, apart from the builder so the row budgets'
// operations can read them without the Durable Object types.
import { BrokerCode, WibDate, type TradeCodes } from "@workspace/relay"

// Decision: Production's busiest measured day, 1,460,000 trades
// (docs/runbooks/order-flow-cost.md, "The estimate model"), over 800 codes
// from 09:00 to 16:15 WIB. The relay missed a few trades, which a walk
// filled as walk_trades rows: the status reads around them, as on a real day.
// Its live books found 24,000 book events, 30 a code.
export const BUSY_DAY = {
  date: WibDate.make("2026-11-09"),
  trades: 1_460_000,
  codes: 800,
  holes: [12_345, 404_040, 777_777, 1_000_001, 1_333_333],
  bookEvents: 24_000,
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
// Decision: trade n's buyer is BROKERS[(n * BUYER_STEP) % BROKERS.length],
// its seller the same with SELLER_STEP, and a side's type F when its number
// (n for the buyer, n + 1 for the seller) is a multiple of FOREIGN_EVERY.
// busy-day.ts writes the broker trades index in SQL with these figures.
export const BUYER_STEP = 7
export const SELLER_STEP = 3
export const FOREIGN_EVERY = 5
const buyerOf = (number: number) =>
  BROKERS[(number * BUYER_STEP) % BROKERS.length]!
const sellerOf = (number: number) =>
  BROKERS[(number * SELLER_STEP) % BROKERS.length]!
const typeOf = (number: number): TradeCodes["buyerType"] =>
  number % FOREIGN_EVERY === 0 ? "F" : "D"

// The codes the busy day holds for trade `number`.
export const busyCodes = (number: number): TradeCodes => ({
  buyer: BrokerCode.make(buyerOf(number)),
  buyerType: typeOf(number),
  seller: BrokerCode.make(sellerOf(number)),
  sellerType: typeOf(number + 1),
})
