// The busy day's figures (billing/busy-day.ts builds it): its date, size,
// holes and the codes it holds, apart from the builder so the row budgets'
// operations can read them without the Durable Object types.
import {
  BrokerCode,
  MINUTE_MS,
  WibDate,
  type TradeCodes,
} from "@workspace/relay"
import { DateTime } from "effect"

// Decision: Production's busiest measured day, 1,460,000 trades
// (docs/runbooks/order-flow-cost.md, "The estimate model"), over 800 codes
// from 09:00 to 16:15 WIB. The relay missed a few trades, which a walk
// filled as walk_trades rows: the status reads around them, as on a real day.
export const BUSY_DAY = {
  date: WibDate.make("2026-11-09"),
  trades: 1_460_000,
  codes: 800,
  holes: [12_345, 404_040, 777_777, 1_000_001, 1_333_333],
  // Decision: one viewed code's book chunks, as many as a busy code stores
  // (spec apinrdw/kumora#555, "Heatmaps worked out on read"): a chunk in 273
  // of the day's 435 minutes, the rest frameless.
  bookCode: "C1",
  bookChunks: 273,
} as const

// Decision: the whole day (billing/whole-day.ts) is the busy day's trades
// recorded live by a fresh object, with books for the 30 codes a viewer
// watched (spec apinrdw/kumora#555, "Testing Decisions"), then walked in
// Ajaib's 5,000-trade pages.
export const WHOLE_DAY = {
  viewed: 30,
  walkBatch: 5_000,
  // The billing Worker's route that records it (billing/worker.ts).
  path: "/whole-day",
} as const

// The busy day's open, 09:00 WIB, and its 435 minutes to 16:15: a trade
// every 17.9 ms.
export const BUSY_OPEN = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-11-09T09:00:00+07:00")
)
export const BUSY_MINUTES = 435
export const BUSY_SPAN_MS = BUSY_MINUTES * MINUTE_MS

// Level `index` of a busy book's side (-1 bid, 1 offer) at frame `frame`:
// 20 levels a side around 1,000, whose lots and orders move with the frame.
export const busyLevel = (side: 1 | -1, frame: number, index: number) => ({
  price: 1_000 + side * (index + 1),
  lots: 100 + ((frame * 7 + index * 13) % 900),
  orders: 1 + ((frame + index) % 30),
})

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
