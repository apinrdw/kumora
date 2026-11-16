// The selected code's sweeps as chart 1's bubbles and the sweep log show them
// (spec apinrdw/kumora#263, "Chart 1"): the top-N filter, the log's rows, and
// where a bubble sits. Pure, so the renderers only draw.
import { CODES_RECHECK } from "@workspace/client"
import { MINUTE_MS, SHARES_PER_LOT } from "@workspace/relay"
import type {
  BrokerCode,
  InvestorType,
  Sweep,
  SweepBroker,
  SweepBrokers,
  TradeNumber,
} from "@workspace/relay"
import { DateTime, Duration, Effect } from "effect"

import { lots as lotsText, plain, tapeTime } from "./format"
import { BIG_TRADE_IDR } from "./tape"

// The top-N presets, All first; the slider steps by 5 between them.
export const TOP_N_PRESETS = [100, 50, 25, 10, 1] as const
export const TOP_N_DEFAULT = 25

// The lot count a sweep needs to show, and each side's cut it came from;
// a side with no sweeps yet has none.
export interface SweepThreshold {
  readonly lots: number
  readonly buy?: number
  readonly sell?: number
}

// The sweeps up to `at` (epoch ms), the replay cursor (live, the end of
// time), in their order: the ones the page shows as of then.
export const sweepsUpTo = <S extends Sweep>(
  sweeps: ReadonlyArray<S>,
  at: number
) =>
  Effect.sync(() =>
    sweeps.filter((sweep) => DateTime.toEpochMillis(sweep.time) <= at)
  )

// The top-N rule: of the kept sweeps up to `at` (epoch ms), each side's own
// lots at its top `percent`% mark (sorted by own lots, descending, the
// ⌈n·N/100⌉-th); the lower of the two is the threshold for both. All
// (100%) hides nothing.
export const sweepThreshold = (
  sweeps: ReadonlyArray<KeptSweep>,
  percent: number,
  at: number
) =>
  Effect.map(sweepsUpTo(sweeps, at), (upTo): SweepThreshold => {
    if (percent >= 100) return { lots: 0 }
    const buy: Array<number> = []
    const sell: Array<number> = []
    for (const sweep of upTo) {
      if (sweep.side === "buy") buy.push(sweep.own)
      else if (sweep.side === "sell") sell.push(sweep.own)
    }
    const cut = (lots: Array<number>) => {
      if (lots.length === 0) return undefined
      lots.sort((a, b) => b - a)
      return lots[Math.max(0, Math.ceil((lots.length * percent) / 100) - 1)]
    }
    const buyCut = cut(buy)
    const sellCut = cut(sell)
    const cuts = [buyCut, sellCut].filter((lots) => lots !== undefined)
    return {
      lots: cuts.length === 0 ? 0 : Math.min(...cuts),
      ...(buyCut === undefined ? {} : { buy: buyCut }),
      ...(sellCut === undefined ? {} : { sell: sellCut }),
    }
  })

const count = new Intl.NumberFormat("en-US")

// The threshold beside the control, `≥ 26 lots (buy 26, sell 34)`, or
// `≥ 26 lots of AK (…)` with AK picked; nothing while it hides nothing.
export const thresholdText = (
  threshold: SweepThreshold,
  picked?: BrokerCode | undefined
) =>
  Effect.sync(() => {
    if (threshold.lots === 0) return ""
    const sides = [
      threshold.buy === undefined ? [] : [`buy ${count.format(threshold.buy)}`],
      threshold.sell === undefined
        ? []
        : [`sell ${count.format(threshold.sell)}`],
    ].flat()
    const of = picked === undefined ? "" : ` of ${picked}`
    return `≥ ${count.format(threshold.lots)} lots${of} (${sides.join(", ")})`
  })

// Whether a kept sweep shows under the threshold, by its own lots. An
// auction match has no aggressor side, so the top-N never hides its row.
const shown = (sweep: KeptSweep, threshold: number) =>
  Effect.sync(() => sweep.side === "none" || sweep.own >= threshold)

export const isBigSweep = (sweep: Sweep) =>
  Effect.sync(() => sweep.value >= BIG_TRADE_IDR)

// One row of the sweep log: the kept sweep and whether it is a big trade.
// Its first trade's number is the id its row and its bubble share.
export interface LogRow extends KeptSweep {
  readonly big: boolean
}

// The sweep log's rows: the kept sweeps up to `at`, newest first, that the
// threshold shows, only big trades when `bigOnly`.
export const logRows = Effect.fnUntraced(function* (
  sweeps: ReadonlyArray<KeptSweep>,
  options: {
    readonly threshold: number
    readonly bigOnly: boolean
    readonly at: number
  }
) {
  const rows: Array<LogRow> = []
  const upTo = yield* sweepsUpTo(sweeps, options.at)
  for (let index = upTo.length - 1; index >= 0; index--) {
    const sweep = upTo[index]!
    if (!(yield* shown(sweep, options.threshold))) continue
    const big = yield* isBigSweep(sweep)
    if (options.bigOnly && !big) continue
    rows.push({ ...sweep, big })
  }
  return rows
})

// What a broker cell shows of one side of a sweep: its Lead broker, the
// broker with the most lots on that side (the first listed on a tie), and
// how many other brokers were on it, the cell's `+N`.
interface LeadBroker {
  readonly code: SweepBroker["code"]
  readonly investorType: SweepBroker["investorType"]
  readonly more: number
}

// A side's Lead broker; none for a side with no brokers.
export const leadBroker = (side: ReadonlyArray<SweepBroker>) =>
  Effect.sync((): LeadBroker | undefined => {
    let lead: SweepBroker | undefined
    for (const broker of side)
      if (lead === undefined || broker.lots > lead.lots) lead = broker
    return (
      lead && {
        code: lead.code,
        investorType: lead.investorType,
        more: side.length - 1,
      }
    )
  })

// A sweep the broker filter keeps, with its own lots: the picked broker's
// aggressor lots in it, the larger of what it bought or sold in an auction
// match, or its whole lots when no broker is picked.
export interface KeptSweep extends Sweep {
  readonly own: number
}

// The sweeps the broker filter keeps: those where the picked broker was any
// of the aggressor-side brokers, and the auction matches it bought or sold
// in (an auction match's entry holds its buyers as `aggressor` and its
// sellers as `other`), so none not yet whole; every sweep when none is
// picked.
export const keptSweeps = (
  sweeps: ReadonlyArray<Sweep>,
  brokers: ReadonlyMap<TradeNumber, SweepBrokers>,
  picked: BrokerCode | undefined
) =>
  Effect.sync((): ReadonlyArray<KeptSweep> => {
    if (picked === undefined)
      return sweeps.map((sweep) => ({ ...sweep, own: sweep.lots }))
    const lotsOf = (side: ReadonlyArray<SweepBroker>) => {
      let lots = 0
      for (const broker of side) if (broker.code === picked) lots += broker.lots
      return lots
    }
    const kept: Array<KeptSweep> = []
    for (const sweep of sweeps) {
      const held = brokers.get(sweep.firstTrade)
      if (held === undefined) continue
      const own =
        sweep.side === "none"
          ? Math.max(lotsOf(held.aggressor), lotsOf(held.other))
          : lotsOf(held.aggressor)
      if (own > 0) kept.push({ ...sweep, own })
    }
    return kept
  })

// The log's note when it shows no row: with a broker picked that was an
// aggressor in no kept sweep up to `at` (epoch ms), it says so. None when
// the broker has sweeps the top-N or Big only hide, nor with none picked.
export const emptyNote = (
  kept: ReadonlyArray<KeptSweep>,
  picked: BrokerCode | undefined,
  at: number
) =>
  Effect.map(sweepsUpTo(kept, at), (upTo) =>
    picked === undefined || upTo.length > 0
      ? undefined
      : `No sweeps where ${picked} was an aggressor.`
  )

// One of the broker filter's choices: a broker with its aggressor lots
// summed over the sweeps, at the investor type it has more of them as.
interface BrokerPick {
  readonly code: BrokerCode
  readonly investorType: InvestorType
  readonly lots: number
}

const OPPOSITE_TYPE = { D: "F", F: "D" } as const

// The broker filter's choices: the aggressor brokers of the whole sweeps up
// to `at` (epoch ms), largest summed aggressor lots first; an auction
// match's buyers are no aggressors. A broker's
// investor type is the one with its larger summed lots, the first it had
// on a tie, as within one sweep (apinrdw/kumora#343, story 5).
export const brokerPicks = (
  sweeps: ReadonlyArray<Sweep>,
  brokers: ReadonlyMap<TradeNumber, SweepBrokers>,
  at: number
) =>
  Effect.map(sweepsUpTo(sweeps, at), (upTo): ReadonlyArray<BrokerPick> => {
    const held = new Map<
      BrokerCode,
      {
        readonly first: InvestorType
        readonly lots: Record<InvestorType, number>
      }
    >()
    for (const sweep of upTo) {
      if (sweep.side === "none") continue
      for (const broker of brokers.get(sweep.firstTrade)?.aggressor ?? []) {
        const entry = held.get(broker.code) ?? {
          first: broker.investorType,
          lots: { D: 0, F: 0 },
        }
        const minorTypeLots = broker.minorTypeLots ?? 0
        entry.lots[broker.investorType] += broker.lots - minorTypeLots
        entry.lots[OPPOSITE_TYPE[broker.investorType]] += minorTypeLots
        held.set(broker.code, entry)
      }
    }
    return [...held]
      .map(([code, { first, lots }]): BrokerPick => {
        const opposite = OPPOSITE_TYPE[first]
        return {
          code,
          investorType: lots[opposite] > lots[first] ? opposite : first,
          lots: lots.D + lots.F,
        }
      })
      .sort((a, b) => b.lots - a.lots)
  })

// The prices a sweep walked, `500→510`, or `500` when it stayed at one.
export const pricePath = Effect.fnUntraced(function* (sweep: Sweep) {
  const first = yield* plain(sweep.first)
  return sweep.first === sweep.last
    ? first
    : `${first}→${yield* plain(sweep.last)}`
})

// What the tooltip on a sweep's bubble and broker cells shows: a title, then
// each side's brokers as stored, largest first, the aggressor side first
// (an auction match's buyers, with no aggressor named); no sides while the
// sweep is not yet whole.
interface SweepTip {
  readonly title: string
  readonly sides:
    | ReadonlyArray<{
        readonly label: string
        readonly brokers: ReadonlyArray<SweepBroker>
      }>
    | undefined
}

const SIDE_WORDS = {
  buy: { side: "Buy", aggressors: "Buyers · aggressor", others: "Sellers" },
  sell: { side: "Sell", aggressors: "Sellers · aggressor", others: "Buyers" },
  none: { side: "Auction", aggressors: "Buyers", others: "Sellers" },
} as const

export const sweepTip = Effect.fnUntraced(function* (
  sweep: Sweep,
  brokers: SweepBrokers | undefined
) {
  const words = SIDE_WORDS[sweep.side]
  const trades = `${yield* plain(sweep.trades)} ${sweep.trades === 1 ? "trade" : "trades"}`
  const time = yield* tapeTime(DateTime.toEpochMillis(sweep.time))
  const tip: SweepTip = {
    title: `${words.side} ${yield* lotsText(sweep.lots)} lots @ ${yield* pricePath(sweep)} · ${trades} · ${time}`,
    sides: brokers && [
      { label: words.aggressors, brokers: brokers.aggressor },
      { label: words.others, brokers: brokers.other },
    ],
  }
  return tip
})

// The note under the log header while a day's codes are incomplete: how
// many sweeps and auction matches up to `at` (epoch ms) have their
// brokers, of all of them.
export const arrivingNote = (
  sweeps: ReadonlyArray<Sweep>,
  brokers: ReadonlyMap<TradeNumber, SweepBrokers>,
  at: number
) =>
  Effect.map(sweepsUpTo(sweeps, at), (upTo) => {
    let all = 0
    let whole = 0
    for (const sweep of upTo) {
      all += 1
      if (brokers.has(sweep.firstTrade)) whole += 1
    }
    return `Codes still arriving: ${count.format(whole)} of ${count.format(all)} sweeps have their brokers. Updates every ${count.format(Duration.toSeconds(CODES_RECHECK))} s.`
  })

// A sweep's average price: its value over its shares.
export const sweepPrice = (sweep: Sweep) =>
  Effect.sync(() => sweep.value / (sweep.lots * SHARES_PER_LOT))

// The start of a sweep's minute, in epoch ms: its candle's.
export const sweepMinute = (sweep: Sweep) =>
  Effect.sync(
    () => Math.floor(DateTime.toEpochMillis(sweep.time) / MINUTE_MS) * MINUTE_MS
  )

// How far a bubble sits from its minute's centre, in pixels at `barSpacing`:
// its second's share of the minute, as the cursor line places that second
// (lib/replay.ts `cursorLogical`, cursor-line.ts).
export const bubbleOffset = (sweep: Sweep, barSpacing: number) =>
  Effect.sync(() => {
    const second = Math.floor(
      (DateTime.toEpochMillis(sweep.time) % MINUTE_MS) / 1000
    )
    return (second / 60) * barSpacing
  })

// A bubble's radius in CSS pixels: its area grows with lots, clamped so a
// 1-lot sweep stays visible and a block doesn't cover the chart.
export const bubbleRadius = (lots: number) =>
  Effect.sync(() => Math.max(1.5, Math.min(24, 0.25 * Math.sqrt(lots))))
