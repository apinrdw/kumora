// A trading day's sweep brokers (spec apinrdw/kumora#343, "The TradingDay
// sweep brokers table"): the buyer and seller brokers of each whole sweep,
// one row per stock code and minute with sweeps, worked out again whenever a
// broker codes batch lands. A stored sweep keeps only its first trade and a
// count, and the trades table has no code index, so the recompute reads each
// touched minute of the whole market and regroups it as the footprint rows
// do (minute-regroup.ts). No other recorded day answer reads the table.
import {
  BrokerCode,
  TradeNumber,
  type InvestorType,
  type StockCode,
  type SweepBroker,
  type SweepBrokers,
  type TradeCodes,
} from "@workspace/relay"
import { Effect } from "effect"

import type { BrokerCodesStore } from "./broker-codes.ts"
import type { DayStore, Sql } from "./day-store.ts"
import { regroupMinute, type CodeMinute } from "./minute-regroup.ts"

// Decision: keyed by (code, minute) WITHOUT ROWID like the footprint rows:
// the answer reads one code's rows, and a recompute replaces each touched
// minute's rows by key, never scanning the table.
const SCHEMA = `CREATE TABLE IF NOT EXISTS sweep_brokers (
  code TEXT NOT NULL,
  minute INTEGER NOT NULL,
  sweeps TEXT NOT NULL,
  PRIMARY KEY (code, minute)
) WITHOUT ROWID`

// The wire tuples' order (@workspace/relay recorded-day.ts `SweepBrokers`);
// change both.
type BrokerTuple = readonly [
  code: SweepBroker["code"],
  investorType: InvestorType,
  lots: number,
]
type SweepTuple = readonly [
  firstTrade: TradeNumber,
  aggressor: ReadonlyArray<BrokerTuple>,
  other: ReadonlyArray<BrokerTuple>,
]

const brokerTuple = (broker: SweepBroker): BrokerTuple => [
  broker.code,
  broker.investorType,
  broker.lots,
]

const sweepsText = (sweeps: ReadonlyArray<SweepBrokers>) =>
  Effect.sync(() =>
    JSON.stringify(
      sweeps.map((sweep): SweepTuple => [
        sweep.firstTrade,
        sweep.aggressor.map(brokerTuple),
        sweep.other.map(brokerTuple),
      ])
    )
  )

// Rows are the table's own writes, so they are read back without a decode.
const sweepsFromText = (text: string) =>
  Effect.sync((): ReadonlyArray<SweepBrokers> => {
    const broker = ([code, investorType, lots]: BrokerTuple): SweepBroker => ({
      code: BrokerCode.make(code),
      investorType,
      lots,
    })
    return (JSON.parse(text) as ReadonlyArray<SweepTuple>).map(
      ([firstTrade, aggressor, other]) => ({
        firstTrade: TradeNumber.make(firstTrade),
        aggressor: aggressor.map(broker),
        other: other.map(broker),
      })
    )
  })

// One side of a sweep: each member trade's broker on that side, with its
// investor type and the trade's lots.
type SideTrade = SweepBroker

// One side's brokers, largest lots first, ties by code. A broker that traded
// both investor types in the sweep carries the one with more of its lots,
// the first it traded on a tie.
const sideOf = (trades: ReadonlyArray<SideTrade>) =>
  Effect.sync((): ReadonlyArray<SweepBroker> => {
    const byCode = new Map<
      SweepBroker["code"],
      { lots: number; types: Map<InvestorType, number> }
    >()
    for (const trade of trades) {
      const held = byCode.get(trade.code) ?? { lots: 0, types: new Map() }
      held.lots += trade.lots
      held.types.set(
        trade.investorType,
        (held.types.get(trade.investorType) ?? 0) + trade.lots
      )
      byCode.set(trade.code, held)
    }
    const brokers: Array<SweepBroker> = []
    for (const [code, { lots, types }] of byCode) {
      let investorType: InvestorType = trades[0]!.investorType
      let most = -1
      for (const [type, typeLots] of types)
        if (typeLots > most) {
          investorType = type
          most = typeLots
        }
      brokers.push({ code, investorType, lots })
    }
    return brokers.sort((a, b) => b.lots - a.lots || (a.code < b.code ? -1 : 1))
  })

// One code's whole sweeps in a minute with their brokers, in trade order. A
// sweep's members are the next `trades` of the code's trades; an auction
// match has no aggressor side, and a sweep with any member lacking codes is
// left out.
const wholeSweeps = Effect.fnUntraced(function* (
  { trades, sweeps }: CodeMinute,
  codes: ReadonlyMap<TradeNumber, TradeCodes>
) {
  const whole: Array<SweepBrokers> = []
  let next = 0
  for (const sweep of sweeps) {
    const members = trades.slice(next, next + sweep.trades)
    next += sweep.trades
    if (sweep.side === "none") continue
    const buyers: Array<SideTrade> = []
    const sellers: Array<SideTrade> = []
    for (const trade of members) {
      const held = codes.get(trade.tradeNumber)
      if (held === undefined) break
      buyers.push({
        code: held.buyer,
        investorType: held.buyerType,
        lots: trade.lots,
      })
      sellers.push({
        code: held.seller,
        investorType: held.sellerType,
        lots: trade.lots,
      })
    }
    if (buyers.length < members.length) continue
    const [aggressor, other] =
      sweep.side === "buy" ? [buyers, sellers] : [sellers, buyers]
    whole.push({
      firstTrade: sweep.firstTrade,
      aggressor: yield* sideOf(aggressor),
      other: yield* sideOf(other),
    })
  }
  return whole
})

// The runs of consecutive numbers in `numbers`, each [first, last].
const runsOf = (numbers: ReadonlyArray<number>) =>
  Effect.sync(() => {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b)
    const runs: Array<[number, number]> = []
    for (const number of sorted) {
      const last = runs.at(-1)
      if (last !== undefined && number === last[1] + 1) last[1] = number
      else runs.push([number, number])
    }
    return runs
  })

export const makeSweepBrokers = Effect.fnUntraced(function* (options: {
  // The trading day's database, shared with the day store.
  readonly sql: Sql
  readonly store: DayStore
  readonly heldCodes: BrokerCodesStore["heldCodes"]
}) {
  const { sql, store } = options
  yield* Effect.sync(() => sql.exec(SCHEMA))

  // One minute's rows worked out again and replaced in one transaction: a
  // code's whole sweeps, or no row when none of its sweeps is whole.
  const recomputeMinute = Effect.fnUntraced(function* (minute: number) {
    const codeMinutes = yield* regroupMinute(yield* store.minuteTrades(minute))
    const codes = new Map(
      yield* options.heldCodes(
        codeMinutes.flatMap(({ trades }) =>
          trades.map((trade) => trade.tradeNumber)
        )
      )
    )
    const rows: Array<readonly [StockCode, string | undefined]> = []
    for (const codeMinute of codeMinutes) {
      if (codeMinute.sweeps.every((sweep) => sweep.side === "none")) continue
      const whole = yield* wholeSweeps(codeMinute, codes)
      rows.push([
        codeMinute.code,
        whole.length === 0 ? undefined : yield* sweepsText(whole),
      ])
    }
    yield* Effect.sync(() =>
      sql.transaction(() => {
        for (const [code, text] of rows)
          if (text === undefined)
            sql.exec(
              "DELETE FROM sweep_brokers WHERE code = ? AND minute = ?",
              code,
              minute
            )
          else
            sql.exec(
              "INSERT OR REPLACE INTO sweep_brokers VALUES (?, ?, ?)",
              code,
              minute,
              text
            )
      })
    )
  })

  // Decision: a batch recomputes the minutes its trade numbers fall in,
  // found per run of consecutive numbers (trade numbers run in time order),
  // so a sparse Stockbit fill recomputes only the minutes it touched. See
  // spec apinrdw/kumora#343, "When it is recomputed".
  const recompute = Effect.fnUntraced(function* (
    numbers: ReadonlyArray<number>
  ) {
    const minutes = new Set<number>()
    for (const [first, last] of yield* runsOf(numbers))
      for (const minute of yield* store.minutesOfTrades(first, last))
        minutes.add(minute)
    for (const minute of [...minutes].sort((a, b) => a - b))
      yield* recomputeMinute(minute)
  })

  // One code's whole sweeps with their brokers, in trade order.
  const sweepsOf = Effect.fnUntraced(function* (code: StockCode) {
    const sweeps: Array<SweepBrokers> = []
    for (const row of sql.exec(
      "SELECT sweeps FROM sweep_brokers WHERE code = ? ORDER BY minute",
      code
    ))
      sweeps.push(...(yield* sweepsFromText(String(row.sweeps))))
    return sweeps
  })

  return { recompute, sweepsOf }
})

export type SweepBrokersStore = Effect.Success<
  ReturnType<typeof makeSweepBrokers>
>
