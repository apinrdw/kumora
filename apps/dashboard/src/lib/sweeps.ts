// The selected code's sweeps as chart 1's bubbles and the sweep log show them
// (spec apinrdw/kumora#263, "Chart 1"): the top-N filter, the log's rows, and
// where a bubble sits. Pure, so the renderers only draw.
import { MINUTE_MS, SHARES_PER_LOT } from "@workspace/relay"
import type {
  Sweep,
  SweepBroker,
  SweepBrokers,
  TradeNumber,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

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

// The top-N rule: of the sweeps up to `at` (epoch ms), each side's lot count
// at its top `percent`% mark (sorted by lots, descending, the
// ⌈n·N/100⌉-th); the lower of the two is the threshold for both. All
// (100%) hides nothing.
export const sweepThreshold = (
  sweeps: ReadonlyArray<Sweep>,
  percent: number,
  at: number
) =>
  Effect.sync((): SweepThreshold => {
    if (percent >= 100) return { lots: 0 }
    const buy: Array<number> = []
    const sell: Array<number> = []
    for (const sweep of sweeps) {
      if (DateTime.toEpochMillis(sweep.time) > at) continue
      if (sweep.side === "buy") buy.push(sweep.lots)
      else if (sweep.side === "sell") sell.push(sweep.lots)
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

// The threshold beside the control, `≥ 26 lots (buy 26, sell 34)`; nothing
// while it hides nothing.
export const thresholdText = (threshold: SweepThreshold) =>
  Effect.sync(() => {
    if (threshold.lots === 0) return ""
    const sides = [
      threshold.buy === undefined ? [] : [`buy ${count.format(threshold.buy)}`],
      threshold.sell === undefined
        ? []
        : [`sell ${count.format(threshold.sell)}`],
    ].flat()
    return `≥ ${count.format(threshold.lots)} lots (${sides.join(", ")})`
  })

// Whether a sweep shows under the threshold. An auction match forms no
// sweep, so the filter never hides its row.
const shown = (sweep: Sweep, threshold: number) =>
  Effect.sync(() => sweep.side === "none" || sweep.lots >= threshold)

export const isBigSweep = (sweep: Sweep) =>
  Effect.sync(() => sweep.value >= BIG_TRADE_IDR)

// One row of the sweep log: the sweep and whether it is a big trade. Its
// first trade's number is the id its row and its bubble share.
export interface LogRow extends Sweep {
  readonly big: boolean
}

// The sweep log's rows: the sweeps up to `at`, newest first, that the
// threshold shows, only big trades when `bigOnly`.
export const logRows = Effect.fnUntraced(function* (
  sweeps: ReadonlyArray<Sweep>,
  options: {
    readonly threshold: number
    readonly bigOnly: boolean
    readonly at: number
  }
) {
  const rows: Array<LogRow> = []
  for (let index = sweeps.length - 1; index >= 0; index--) {
    const sweep = sweeps[index]!
    if (DateTime.toEpochMillis(sweep.time) > options.at) continue
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

// The note under the log header while a day's codes are incomplete: how
// many sweeps up to `at` (epoch ms) have their brokers, of all of them. An
// auction match forms no sweep, so it counts in neither.
export const arrivingNote = (
  sweeps: ReadonlyArray<Sweep>,
  brokers: ReadonlyMap<TradeNumber, SweepBrokers>,
  at: number
) =>
  Effect.sync(() => {
    let all = 0
    let whole = 0
    for (const sweep of sweeps) {
      if (sweep.side === "none" || DateTime.toEpochMillis(sweep.time) > at)
        continue
      all += 1
      if (brokers.has(sweep.firstTrade)) whole += 1
    }
    return `Codes still arriving: ${count.format(whole)} of ${count.format(all)} sweeps have their brokers. Updates every 30 s.`
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
