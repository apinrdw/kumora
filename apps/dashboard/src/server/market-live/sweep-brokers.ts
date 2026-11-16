// A trading day's sweep brokers (spec apinrdw/kumora#343, "The TradingDay
// sweep brokers table"): the buyer and seller brokers of each whole sweep,
// one row per stock code and minute with sweeps, worked out again whenever a
// broker codes batch lands. A stored sweep keeps only its first trade and a
// count, and the trades table has no code index, so the recompute reads each
// touched minute of the whole market and regroups it as the footprint rows
// do (minute-regroup.ts). No other recorded day answer reads the table.
import {
  TradeNumber,
  decodeSweepBrokersText,
  encodeSweepBrokersText,
  sweepsOf,
  type InvestorType,
  type RunningTrade,
  type StockCode,
  type SweepBroker,
  type SweepBrokers,
  type SweepPiece,
  type TradeCodes,
  MINUTE_MS,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { BrokerCodesStore, HeldCodes } from "./broker-codes.ts"
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

// A row's sweeps as stored, in the answer's encoding. Rows are the table's
// own writes, so a row that fails to encode or decode is a defect.
const sweepsText = (sweeps: ReadonlyArray<SweepBrokers>) =>
  Effect.orDie(encodeSweepBrokersText(sweeps))
const sweepsFromText = (text: string) =>
  Effect.orDie(decodeSweepBrokersText(text))

// One member trade's broker on one side of a sweep, with its investor type
// and the trade's lots.
type MemberBroker = Omit<SweepBroker, "minorTypeLots">

// One side's brokers, largest lots first, ties by code. A broker that traded
// both investor types in the sweep carries the one with more of its lots,
// the first it traded on a tie, and its lots of the minor type.
const sideOf = (trades: ReadonlyArray<MemberBroker>) =>
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
      brokers.push(
        most === lots
          ? { code, investorType, lots }
          : { code, investorType, lots, minorTypeLots: lots - most }
      )
    }
    return brokers.sort((a, b) => b.lots - a.lots || (a.code < b.code ? -1 : 1))
  })

// One piece of a whole sweep: its member trades, in trade order, as a sweep
// of their own, with each side's brokers.
const pieceOf = Effect.fnUntraced(function* (
  trades: ReadonlyArray<RunningTrade>,
  codes: ReadonlyMap<TradeNumber, TradeCodes>
) {
  const buyers: Array<MemberBroker> = []
  const sellers: Array<MemberBroker> = []
  for (const trade of trades) {
    const held = codes.get(trade.tradeNumber)!
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
  // One side and one second: one sweep.
  const [sweep] = yield* sweepsOf(trades)
  const [aggressor, other] =
    sweep!.side === "sell" ? [sellers, buyers] : [buyers, sellers]
  const piece: SweepPiece = {
    ...sweep!,
    aggressor: yield* sideOf(aggressor),
    other: yield* sideOf(other),
  }
  return piece
})

// One code's whole sweeps and auction matches in a minute with their
// pieces, in trade order. A sweep's members are the next `trades` of the
// code's trades, and one with any member lacking codes is left out.
// Decision: a whole sweep splits by aggressor broker (the seller of a sell
// sweep, the buyer of a buy sweep), each broker's members one piece however
// interleaved. An auction match has no aggressor: one piece, its buyers in
// `aggressor`. See spec apinrdw/kumora#384, "Where the split happens".
const wholeSweeps = Effect.fnUntraced(function* (
  { trades, sweeps }: CodeMinute,
  codes: ReadonlyMap<TradeNumber, TradeCodes>
) {
  const whole: Array<SweepBrokers> = []
  let next = 0
  for (const sweep of sweeps) {
    const members = trades.slice(next, next + sweep.trades)
    next += sweep.trades
    if (members.some((trade) => !codes.has(trade.tradeNumber))) continue
    const byAggressor = new Map<string, Array<RunningTrade>>()
    for (const trade of members) {
      const held = codes.get(trade.tradeNumber)!
      const aggressor =
        sweep.side === "none"
          ? ""
          : sweep.side === "sell"
            ? held.seller
            : held.buyer
      const piece = byAggressor.get(aggressor) ?? []
      piece.push(trade)
      byAggressor.set(aggressor, piece)
    }
    const pieces: Array<SweepPiece> = []
    for (const piece of byAggressor.values())
      pieces.push(yield* pieceOf(piece, codes))
    whole.push({ firstTrade: sweep.firstTrade, pieces })
  }
  return whole
})

// The runs of consecutive trade numbers in `numbers`, each [first, last].
const runsOf = (numbers: ReadonlyArray<TradeNumber>) =>
  Effect.sync(() => {
    const sorted = [...new Set(numbers.map(Number))].sort((a, b) => a - b)
    const runs: Array<[number, number]> = []
    for (const number of sorted) {
      const last = runs.at(-1)
      if (last !== undefined && number === last[1] + 1) last[1] = number
      else runs.push([number, number])
    }
    return runs.map(
      ([first, last]) =>
        [
          TradeNumber.make(String(first)),
          TradeNumber.make(String(last)),
        ] as const
    )
  })

// The rows of one minute to write: each code's whole sweeps' text, or none
// to delete its row.
type MinuteRows = ReadonlyArray<readonly [StockCode, string | undefined]>

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

  // The stored text of one code's row for one minute, if any.
  const storedText = (code: StockCode, minute: number) =>
    Effect.sync(() => {
      const [row] = sql.exec(
        "SELECT sweeps FROM sweep_brokers WHERE code = ? AND minute = ?",
        code,
        minute
      )
      return row === undefined ? undefined : String(row.sweeps)
    })

  // One minute's rows worked out again from the codes `heldCodes` reads,
  // metering the rows it read: for each code, its whole sweeps' and auction
  // matches' text, or none when none is whole.
  // Decision: a row whose bytes are already stored is left out, and so is
  // a delete of a row never stored, so a batch writes only the rows it
  // changes, not every code's row of each minute it touches. See
  // docs/runbooks/order-flow-cost.md, "Sweep brokers: one Staging evening".
  const minuteRows = (minute: number, heldCodes: HeldCodes) =>
    store.sweepBrokerMinute(
      Effect.gen(function* () {
        const codeMinutes = yield* regroupMinute(
          yield* store.minuteTrades(minute)
        )
        const codes = new Map(
          yield* heldCodes(
            codeMinutes.flatMap(({ trades }) =>
              trades.map((trade) => trade.tradeNumber)
            )
          )
        )
        const rows: Array<MinuteRows[number]> = []
        for (const codeMinute of codeMinutes) {
          const whole = yield* wholeSweeps(codeMinute, codes)
          const text = whole.length === 0 ? undefined : yield* sweepsText(whole)
          if (text !== (yield* storedText(codeMinute.code, minute)))
            rows.push([codeMinute.code, text])
        }
        return rows
      })
    )

  // Replaces one minute's rows, inside the caller's transaction.
  const writeRows = (minute: number, rows: MinuteRows) => {
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
  }

  // One minute of the build: its rows replaced in one transaction with
  // `facts`.
  const buildMinute = Effect.fnUntraced(function* (
    minute: number,
    facts: Readonly<Record<string, string>>
  ) {
    const rows = yield* minuteRows(minute, brokerCodes.heldCodes)
    // Decision: a minute whose rows are all stored still writes `facts`, the
    // build's progress, so a build cut off after a long run of such minutes
    // resumes past them. See apinrdw/kumora#371.
    yield* store.writeSweepBrokers(rows.length, facts, () =>
      writeRows(minute, rows)
    )
  })

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

  // Decision: after the seal each recompute, and the build as it ends, logs
  // its own line; before it, the counts ride the next `Rows written`. The
  // storage line is logged again the first time an object finds the sealed
  // day's codes complete, checked after every accepted batch. See spec
  // apinrdw/kumora#343, "Cost", and PR apinrdw/kumora#349.
  let storageLogged = false
  const recomputeLogged = Effect.gen(function* () {
    if ((yield* store.fact(Fact.sealed)) === undefined) return
    yield* Effect.logInfo("Sweep brokers recomputed").pipe(
      Effect.annotateLogs({ ...(yield* store.takeMeter) })
    )
  })
  const completed = Effect.gen(function* () {
    if (storageLogged || (yield* store.fact(Fact.sealed)) === undefined) return
    if (!(yield* brokerCodes.isComplete)) return
    storageLogged = true
    yield* Effect.logInfo("Order flow storage").pipe(
      Effect.annotateLogs({
        ...(yield* store.orderFlowStorage),
        ...(yield* storage),
      })
    )
  })

  // The build's progress as the last minute it wrote; none while it has
  // not started, once it finished, or under an older finished value (the
  // Decision on SWEEP_BROKERS_BUILT), whose build starts again from the
  // day's first minute.
  const minuteOf = (progress: string | undefined) =>
    Effect.sync(() =>
      progress === undefined || !/^\d+$/.test(progress)
        ? undefined
        : Number(progress)
    )

  // Decision: the build goes minute by minute, each minute's rows and its
  // progress in one transaction, as the order flow build does
  // (order-flow-build.ts): a build that dies reruns from the minute after
  // the last that landed. A day with no tape has no minute and builds
  // nothing. See spec apinrdw/kumora#343, "The one-off build".
  const build = Effect.gen(function* () {
    const progress = yield* store.fact(Fact.sweepBrokersBuilt)
    if (progress === SWEEP_BROKERS_BUILT) return
    const reached = yield* minuteOf(progress)
    const span = yield* store.orderFlowMinutes
    if (span !== undefined) {
      const from =
        reached === undefined
          ? span.first
          : Math.max(span.first, reached + MINUTE_MS)
      for (let minute = from; minute <= span.last; minute += MINUTE_MS)
        yield* buildMinute(minute, {
          [Fact.sweepBrokersBuilt]: String(minute),
        })
    }
    yield* store.markSweepBrokersBuilt
    yield* recomputeLogged
    yield* completed
  })

  // Decision: a day holding no codes as its object starts gets each batch's
  // rows as it lands, so it is marked built from the start. A day holding
  // codes without the current mark (sweep brokers or auction entries came
  // after them, or a late trade did) is built by its next sweep brokers GET.
  // See spec apinrdw/kumora#343, "The one-off build", and #384, "Old days".
  const progress = yield* store.fact(Fact.sweepBrokersBuilt)
  let built = progress === SWEEP_BROKERS_BUILT
  if (
    !built &&
    (yield* minuteOf(progress)) === undefined &&
    (yield* brokerCodes.holdsNone)
  ) {
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

  // The rows are worked out from the codes `heldCodes` reads, the batch's,
  // and written with `writeCodes` in one transaction (broker-codes.ts,
  // `write`), so the meter's billed rows written count the batch's own
  // chunk and fact writes too: a few rows per batch.
  // Decision: a batch recomputes the minutes its trade numbers fall in,
  // found per run of consecutive numbers (trade numbers run in time order),
  // so a sparse Stockbit fill recomputes only the minutes it touched. See
  // spec apinrdw/kumora#343, "When it is recomputed".
  const recompute = Effect.fnUntraced(function* (
    numbers: ReadonlyArray<TradeNumber>,
    heldCodes: HeldCodes,
    writeCodes: () => void
  ) {
    const minutes = new Set<number>()
    for (const [first, last] of yield* runsOf(numbers))
      for (const minute of yield* store.minutesOfTrades(first, last))
        minutes.add(minute)
    const rows: Array<readonly [number, MinuteRows]> = []
    let count = 0
    for (const minute of [...minutes].sort((a, b) => a - b)) {
      const changed = yield* minuteRows(minute, heldCodes)
      rows.push([minute, changed])
      count += changed.length
    }
    yield* store.writeSweepBrokers(count, {}, () => {
      writeCodes()
      for (const [minute, changed] of rows) writeRows(minute, changed)
    })
    yield* recomputeLogged
  })

  // The fact a flush of `trades` writes with them: the build's progress
  // moved back before the earliest minute holding one; none while the day
  // holds no codes, or while its build is still to start from its first
  // minute.
  // Decision: once the day holds codes, every flushed trade, coded or not,
  // moves the build back in its flush's transaction: a trade stored after a
  // recompute can bring codes, join a sweep or split one, and a sweep never
  // crosses a minute, so the day's next GET rebuilds from its minute.
  // See spec apinrdw/kumora#343, "The one-off build", apinrdw/kumora#349.
  const persisting = Effect.fnUntraced(function* (
    trades: ReadonlyArray<RunningTrade>
  ) {
    const none: Readonly<Record<string, string>> = {}
    const stored = yield* store.fact(Fact.sweepBrokersBuilt)
    const reached = yield* minuteOf(stored)
    if (
      trades.length === 0 ||
      (stored !== SWEEP_BROKERS_BUILT && reached === undefined) ||
      (yield* brokerCodes.holdsNone)
    )
      return none
    let earliest = Infinity
    for (const trade of trades)
      earliest = Math.min(earliest, DateTime.toEpochMillis(trade.time))
    const before = Math.floor(earliest / MINUTE_MS) * MINUTE_MS - MINUTE_MS
    built = false
    const facts: Record<string, string> = {
      [Fact.sweepBrokersBuilt]: String(
        reached === undefined ? before : Math.min(reached, before)
      ),
    }
    return facts
  })

  // One code's whole sweeps and auction matches with their pieces, in
  // trade order.
  const brokersOf = Effect.fnUntraced(function* (code: StockCode) {
    const sweeps: Array<SweepBrokers> = []
    for (const row of sql.exec(
      "SELECT sweeps FROM sweep_brokers WHERE code = ? ORDER BY minute",
      code
    ))
      sweeps.push(...(yield* sweepsFromText(String(row.sweeps))))
    return sweeps
  })

  return {
    recompute,
    completed,
    persisting,
    builtFirst,
    storage,
    brokersOf,
  }
})

export type SweepBrokersStore = Effect.Success<
  ReturnType<typeof makeSweepBrokers>
>
