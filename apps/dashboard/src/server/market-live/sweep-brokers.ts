// A trading day's sweep brokers (spec apinrdw/kumora#343, "The TradingDay
// sweep brokers table"): the buyer and seller brokers of each whole sweep,
// one row per stock code and minute with sweeps, worked out again whenever a
// broker codes batch lands. A stored sweep keeps only its first trade and a
// count, and the tape has no code index, so the recompute reads each
// touched minute of the whole market and regroups it as the footprint rows
// do (minute-regroup.ts). No other recorded day answer reads the table.
import { gunzipSync, gzipSync } from "node:zlib"

import {
  TradeNumber,
  decodeSweepBrokersText,
  encodeSweepBrokersText,
  sweepsOf,
  type BrokerCode,
  type InvestorType,
  type OrderNumber,
  type OrderNumbers,
  type RunningTrade,
  type Sweep,
  type StockCode,
  type SweepBroker,
  type SweepBrokers,
  type SweepOrders,
  type SweepPiece,
  type TradeCodes,
  MINUTE_MS,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import type { BrokerCodesStore, HeldReads } from "./broker-codes.ts"
import {
  Fact,
  SWEEP_BROKERS_BUILT,
  SWEEP_BROKERS_SHAPE,
  type DayStore,
  type Sql,
  type SqlValue,
} from "./day-store.ts"
import { regroupMinute, type CodeMinute } from "./minute-regroup.ts"

// Decision: day store tables are keyed WITHOUT ROWID; trades are the tape's
// (apps/dashboard/docs/adr/0078-day-store-tables-are-keyed-without-rowid.md)
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

// Decision: a sweep brokers row is a gzipped BLOB
// (apps/dashboard/docs/adr/0099-new-sweep-brokers-rows-are-gzipped-blobs.md)
const storedSweeps = (text: string) =>
  Effect.sync(() => new Uint8Array(gzipSync(text)))
const textOf = (stored: SqlValue | undefined) =>
  Effect.sync(() => new TextDecoder().decode(gunzipSync(stored as Uint8Array)))

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

// Which party of a trade each side of a sweep holds, as `SweepPiece`
// names them.
type TradeParty = "buyer" | "seller"
const PARTIES = {
  buy: { aggressor: "buyer", other: "seller" },
  sell: { aggressor: "seller", other: "buyer" },
  none: { aggressor: "buyer", other: "seller" },
} as const satisfies Record<
  Sweep["side"],
  { aggressor: TradeParty; other: TradeParty }
>

// The kept codes and order numbers of a minute's trades, by trade number.
interface MinuteHeld {
  readonly codes: ReadonlyMap<TradeNumber, TradeCodes>
  readonly orders: ReadonlyMap<TradeNumber, OrderNumbers>
}

// One piece of a whole sweep: its member trades, in trade order, as a sweep
// of their own, with each side's brokers, and an order run's orders.
const pieceOf = Effect.fnUntraced(function* (
  trades: ReadonlyArray<RunningTrade>,
  codes: MinuteHeld["codes"],
  orders?: SweepOrders
) {
  // One side and one second: one sweep.
  const [sweep] = yield* sweepsOf(trades)
  const partyOf = (party: TradeParty) =>
    sideOf(
      trades.map((trade) => {
        const held = codes.get(trade.tradeNumber)!
        return {
          code: held[party],
          investorType: held[`${party}Type`],
          lots: trade.lots,
        }
      })
    )
  const parties = PARTIES[sweep!.side]
  const piece: SweepPiece = {
    ...sweep!,
    aggressor: yield* partyOf(parties.aggressor),
    other: yield* partyOf(parties.other),
    ...(orders === undefined ? {} : { orders }),
  }
  return piece
})

// An order run joins one aggressor broker's next aggressor order
// while its number is at most this far above the previous one's. The
// order-number count is market-wide, about 113 a second: one sender's
// bursts step by 1–3, a retail broker's customers in the same second by
// hundreds. See apinrdw/kumora#621 and its measurement, #620.
const ORDER_RUN_GAP = 3

// Which of a trade's [buy, sell] order numbers is its aggressor order on
// each side, the other its passive order's.
const AGGRESSOR_ORDER = { buy: 0, sell: 1 } as const

// One aggressor broker's trades of a whole sweep split into order runs,
// each run's trades in trade order with its orders.
const orderRunsOf = Effect.fnUntraced(function* (
  trades: ReadonlyArray<RunningTrade>,
  side: "buy" | "sell",
  orders: MinuteHeld["orders"]
) {
  const aggressorAt = AGGRESSOR_ORDER[side]
  const numbers = [
    ...new Set(
      trades.map((trade) => orders.get(trade.tradeNumber)![aggressorAt])
    ),
  ].sort((a, b) => a - b)
  // Each run's aggressor orders, its trades, and its passive orders' lots.
  const runs: Array<{
    readonly numbers: Array<OrderNumber>
    readonly trades: Array<RunningTrade>
    readonly passive: Map<OrderNumber, number>
  }> = []
  const runOf = new Map<OrderNumber, (typeof runs)[number]>()
  for (const number of numbers) {
    const last = runs.at(-1)
    const joins =
      last !== undefined && number - last.numbers.at(-1)! <= ORDER_RUN_GAP
    const into = joins
      ? last
      : { numbers: [], trades: [], passive: new Map<OrderNumber, number>() }
    if (!joins) runs.push(into)
    into.numbers.push(number)
    runOf.set(number, into)
  }
  for (const trade of trades) {
    const held = orders.get(trade.tradeNumber)!
    const into = runOf.get(held[aggressorAt])!
    into.trades.push(trade)
    const passive = held[1 - aggressorAt]!
    into.passive.set(passive, (into.passive.get(passive) ?? 0) + trade.lots)
  }
  return runs.map((run) => ({
    trades: run.trades,
    orders: {
      count: run.numbers.length,
      first: run.numbers[0]!,
      last: run.numbers.at(-1)!,
      biggestPassiveLots: Math.max(...run.passive.values()),
    } satisfies SweepOrders,
  }))
})

// A sided whole sweep's pieces, in trade order: each aggressor broker's
// members one piece however interleaved, or, when every member has order
// numbers, each of its order runs one piece.
const sidedPieces = Effect.fnUntraced(function* (
  members: ReadonlyArray<RunningTrade>,
  side: "buy" | "sell",
  held: MinuteHeld
) {
  const aggressor = PARTIES[side].aggressor
  const byAggressor = new Map<BrokerCode, Array<RunningTrade>>()
  for (const trade of members) {
    const code = held.codes.get(trade.tradeNumber)![aggressor]
    const piece = byAggressor.get(code) ?? []
    piece.push(trade)
    byAggressor.set(code, piece)
  }
  const pieces: Array<SweepPiece> = []
  const ordered = members.every((trade) => held.orders.has(trade.tradeNumber))
  for (const trades of byAggressor.values()) {
    if (!ordered) {
      pieces.push(yield* pieceOf(trades, held.codes))
      continue
    }
    for (const run of yield* orderRunsOf(trades, side, held.orders))
      pieces.push(yield* pieceOf(run.trades, held.codes, run.orders))
  }
  return pieces.sort((a, b) => Number(a.firstTrade) - Number(b.firstTrade))
})

// One code's whole sweeps and auction matches in a minute with their
// pieces, in trade order. A sweep's members are the next `trades` of the
// code's trades, and one with any member lacking codes is left out.
// Decision: a sweep splits by aggressor broker, or by order run once numbered
// (apps/dashboard/docs/adr/0100-a-sweep-splits-by-aggressor-broker-or-by-order-run.md)
const wholeSweeps = Effect.fnUntraced(function* (
  { trades, sweeps }: CodeMinute,
  held: MinuteHeld
) {
  const whole: Array<SweepBrokers> = []
  let next = 0
  for (const sweep of sweeps) {
    const members = trades.slice(next, next + sweep.trades)
    next += sweep.trades
    if (members.some((trade) => !held.codes.has(trade.tradeNumber))) continue
    whole.push({
      firstTrade: sweep.firstTrade,
      pieces:
        sweep.side === "none"
          ? [yield* pieceOf(members, held.codes)]
          : yield* sidedPieces(members, sweep.side, held),
    })
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

// The build's progress fact once it wrote `minute`, under the rows' shape.
const reachedFact = (minute: number): Readonly<Record<string, string>> => ({
  [Fact.sweepBrokersBuilt]: `${SWEEP_BROKERS_SHAPE}:${minute}`,
})
const REACHED = new RegExp(`^${SWEEP_BROKERS_SHAPE}:(\\d+)$`)

// The rows of one minute to write: each code's whole sweeps as stored, or
// none to delete its row.
type MinuteRows = ReadonlyArray<readonly [StockCode, Uint8Array | undefined]>

export const makeSweepBrokers = Effect.fnUntraced(function* (options: {
  // The trading day's database, shared with the day store.
  readonly sql: Sql
  readonly store: DayStore
  readonly brokerCodes: Pick<
    BrokerCodesStore,
    "heldCodes" | "heldOrderNumbers" | "codesComplete" | "holdsNone"
  >
}) {
  const { sql, store, brokerCodes } = options
  yield* Effect.sync(() => sql.exec(SCHEMA))

  // The stored text of one code's row for one minute, if any.
  const storedText = Effect.fnUntraced(function* (
    code: StockCode,
    minute: number
  ) {
    const [row] = sql.exec(
      "SELECT sweeps FROM sweep_brokers WHERE code = ? AND minute = ?",
      code,
      minute
    )
    return row === undefined ? undefined : yield* textOf(row.sweeps)
  })

  // One minute's rows worked out again from the codes and order numbers
  // `held` reads, metering the rows it read: for each code, its whole
  // sweeps' and auction matches' text, or none when none is whole.
  // A row whose text is already stored is left out, and so is a delete of a
  // row never stored, so a batch writes only the rows it changes, not every
  // code's row of each minute it touches. See apinrdw/kumora#348.
  const minuteRows = (minute: number, held: HeldReads) =>
    store.sweepBrokerMinute(
      Effect.gen(function* () {
        const codeMinutes = yield* regroupMinute(
          yield* store.minuteTrades(minute)
        )
        const numbers = codeMinutes.flatMap(({ trades }) =>
          trades.map((trade) => trade.tradeNumber)
        )
        const minuteHeld: MinuteHeld = {
          codes: new Map(yield* held.codes(numbers)),
          orders: new Map(yield* held.orders(numbers)),
        }
        const rows: Array<MinuteRows[number]> = []
        for (const codeMinute of codeMinutes) {
          const whole = yield* wholeSweeps(codeMinute, minuteHeld)
          const text = whole.length === 0 ? undefined : yield* sweepsText(whole)
          if (text !== (yield* storedText(codeMinute.code, minute)))
            rows.push([
              codeMinute.code,
              text === undefined ? undefined : yield* storedSweeps(text),
            ])
        }
        return rows
      })
    )

  // Replaces one minute's rows, inside the caller's transaction.
  const writeRows = (minute: number, rows: MinuteRows) => {
    for (const [code, sweeps] of rows)
      if (sweeps === undefined)
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
          sweeps
        )
  }

  // One minute of the build: its rows replaced in one transaction with
  // `facts`.
  const buildMinute = Effect.fnUntraced(function* (
    minute: number,
    facts: Readonly<Record<string, string>>
  ) {
    const rows = yield* minuteRows(minute, {
      codes: brokerCodes.heldCodes,
      orders: brokerCodes.heldOrderNumbers,
    })
    // A minute whose rows are all stored still writes `facts`, the
    // build's progress, so a build cut off after a long run of such minutes
    // resumes past them. See apinrdw/kumora#371.
    yield* store.writeSweepBrokers(rows.length, facts, () =>
      writeRows(minute, rows)
    )
  })

  // How many rows the table holds and their payload bytes as stored,
  // gzipped.
  const storage = Effect.sync(() => {
    const [row] = sql.exec(
      "SELECT count(*) AS rows, coalesce(sum(length(sweeps)), 0) AS bytes FROM sweep_brokers"
    )
    return {
      sweepBrokerRows: Number(row?.rows),
      sweepBrokerBytes: Number(row?.bytes),
    }
  })

  // After the seal each recompute, and the build as it ends, logs
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
    if (!(yield* brokerCodes.codesComplete)) return
    storageLogged = true
    yield* Effect.logInfo("Order flow storage").pipe(
      Effect.annotateLogs({
        ...(yield* store.orderFlowStorage),
        ...(yield* storage),
      })
    )
  })

  // The build's progress as the last minute it wrote; none while it has
  // not started, once it finished, or under an older shape (the Decision on
  // SWEEP_BROKERS_SHAPE), whose build starts again from the day's first
  // minute.
  const minuteOf = (progress: string | undefined) =>
    Effect.sync(() => {
      const reached = progress?.match(REACHED)?.[1]
      return reached === undefined ? undefined : Number(reached)
    })

  // The build goes minute by minute, each minute's rows and its
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
        yield* buildMinute(minute, reachedFact(minute))
    }
    yield* store.markSweepBrokersBuilt
    yield* recomputeLogged
    yield* completed
  })

  // A day holding no codes as its object starts gets each batch's
  // rows as it lands, so it is marked built from the start. A day holding
  // codes without the current mark (sweep brokers or their shape came after
  // them, or a late trade did) is built by its next sweep brokers GET.
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

  // The rows are worked out from the codes and order numbers `held` reads,
  // the batch's, and written with `writeCodes` in one transaction
  // (broker-codes.ts, `write`), so the meter's billed rows written count the
  // batch's own chunk and fact writes too: a few rows per batch.
  // A batch recomputes the minutes its changed trades' numbers
  // fall in, found per run of consecutive numbers (trade numbers run in time
  // order), so a sparse Stockbit fill recomputes only the minutes it
  // touched. A batch that changed only order numbers counts the same. See
  // spec apinrdw/kumora#343, "When it is recomputed", and #627, "Slice 2".
  const recompute = Effect.fnUntraced(function* (
    numbers: ReadonlyArray<TradeNumber>,
    held: HeldReads,
    writeCodes: () => void
  ) {
    const minutes = new Set<number>()
    for (const [first, last] of yield* runsOf(numbers))
      for (const minute of yield* store.minutesOfTrades(first, last))
        minutes.add(minute)
    const rows: Array<readonly [number, MinuteRows]> = []
    let count = 0
    for (const minute of [...minutes].sort((a, b) => a - b)) {
      const changed = yield* minuteRows(minute, held)
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
  // Decision: once a day holds codes, every flushed trade moves the build back
  // (apps/dashboard/docs/adr/0101-every-flushed-trade-moves-the-sweep-brokers-build-back.md)
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
    return reachedFact(
      reached === undefined ? before : Math.min(reached, before)
    )
  })

  // One code's whole sweeps and auction matches with their pieces, in
  // trade order.
  const brokersOf = Effect.fnUntraced(function* (code: StockCode) {
    const sweeps: Array<SweepBrokers> = []
    for (const row of sql.exec(
      "SELECT sweeps FROM sweep_brokers WHERE code = ? ORDER BY minute",
      code
    ))
      sweeps.push(...(yield* sweepsFromText(yield* textOf(row.sweeps))))
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
