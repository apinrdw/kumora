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
  MINUTE_MS,
} from "@workspace/relay"
import { Effect } from "effect"

import type { BrokerCodesStore } from "./broker-codes.ts"
import {
  Fact,
  SWEEP_BROKERS_BUILT,
  type DayStore,
  type Sql,
} from "./day-store.ts"
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
  readonly brokerCodes: Pick<
    BrokerCodesStore,
    "heldCodes" | "isComplete" | "holdsNone"
  >
}) {
  const { sql, store, brokerCodes } = options
  yield* Effect.sync(() => sql.exec(SCHEMA))

  // One minute's rows worked out again and replaced in one transaction with
  // `facts`: a code's whole sweeps, or no row when none of its sweeps is
  // whole. A minute without a sided sweep writes nothing.
  const recomputeMinute = (
    minute: number,
    facts: Readonly<Record<string, string>> = {}
  ) =>
    store.sweepBrokerMinute(
      Effect.gen(function* () {
        const codeMinutes = yield* regroupMinute(
          yield* store.minuteTrades(minute)
        )
        const codes = new Map(
          yield* brokerCodes.heldCodes(
            codeMinutes.flatMap(({ trades }) =>
              trades.map((trade) => trade.tradeNumber)
            )
          )
        )
        const rows: Array<readonly [StockCode, string | undefined]> = []
        for (const codeMinute of codeMinutes) {
          if (codeMinute.sweeps.every((sweep) => sweep.side === "none"))
            continue
          const whole = yield* wholeSweeps(codeMinute, codes)
          rows.push([
            codeMinute.code,
            whole.length === 0 ? undefined : yield* sweepsText(whole),
          ])
        }
        if (rows.length === 0) return
        yield* store.writeSweepBrokers(rows.length, facts, () => {
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
      })
    )

  // How many rows the table holds and their payload bytes.
  const storage = Effect.sync(() => {
    const [row] = sql.exec(
      "SELECT count(*) AS rows, coalesce(sum(length(sweeps)), 0) AS bytes FROM sweep_brokers"
    )
    return {
      sweepBrokerRows: Number(row?.rows),
      sweepBrokerBytes: Number(row?.bytes),
    }
  })

  // Decision: after the seal no flush logs the meter, so each recompute
  // logs its own line; before it, the counts ride the next `Rows written`.
  // The storage line is logged again, with this table, the first time a
  // sealed day's codes are complete. See spec apinrdw/kumora#343, "Cost".
  // The Staging check reads both: docs/runbooks/order-flow-cost.md.
  let storageLogged = false
  const logged = Effect.gen(function* () {
    if ((yield* store.fact(Fact.sealed)) === undefined) return
    yield* Effect.logInfo("Sweep brokers recomputed").pipe(
      Effect.annotateLogs({ ...(yield* store.takeMeter) })
    )
    if (storageLogged || !(yield* brokerCodes.isComplete)) return
    storageLogged = true
    yield* Effect.logInfo("Order flow storage").pipe(
      Effect.annotateLogs({
        ...(yield* store.orderFlowStorage),
        ...(yield* storage),
      })
    )
  })

  // Decision: the build goes minute by minute, each minute's rows and its
  // progress in one transaction, as the order flow build does
  // (order-flow-build.ts): a build that dies reruns from the minute after
  // the last that landed. A day with no tape has no minute and builds
  // nothing. See spec apinrdw/kumora#343, "The one-off build".
  const build = Effect.gen(function* () {
    const progress = yield* store.fact(Fact.sweepBrokersBuilt)
    if (progress === SWEEP_BROKERS_BUILT) return
    const span = yield* store.orderFlowMinutes
    if (span !== undefined) {
      const from =
        progress === undefined
          ? span.first
          : Math.max(span.first, Number(progress) + MINUTE_MS)
      for (let minute = from; minute <= span.last; minute += MINUTE_MS)
        yield* recomputeMinute(minute, {
          [Fact.sweepBrokersBuilt]: String(minute),
        })
    }
    yield* store.markSweepBrokersBuilt
    yield* logged
  })

  // Decision: a day holding no codes as its object starts gets each batch's
  // rows as it lands, so it is marked built from the start. A day already
  // holding codes without the mark took them, whole or in part, before
  // sweep brokers shipped: once sealed, its first sweep brokers GET builds
  // the rows. See spec apinrdw/kumora#343, "The one-off build".
  const progress = yield* store.fact(Fact.sweepBrokersBuilt)
  let built = progress === SWEEP_BROKERS_BUILT
  if (progress === undefined && (yield* brokerCodes.holdsNone)) {
    yield* store.markSweepBrokersBuilt
    built = true
  }

  // The rows built first, if the day still needs its one-off build.
  const builtFirst = Effect.suspend(() =>
    built
      ? Effect.void
      : Effect.tap(build, () =>
          Effect.sync(() => {
            built = true
          })
        )
  )

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
    yield* logged
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

  return { recompute, builtFirst, storage, sweepsOf }
})

export type SweepBrokersStore = Effect.Success<
  ReturnType<typeof makeSweepBrokers>
>
