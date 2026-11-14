// The selected code's sweeps as chart 1's bubbles and the sweep log show them
// (spec apinrdw/kumora#263, "Chart 1"): the top-N filter, the log's rows, and
// where a bubble sits. Pure, so the renderers only draw.
import type { Sweep } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { BIG_TRADE_IDR } from "./tape"

const MINUTE = 60_000

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

// One row of the sweep log: the sweep, its place in the code's sweeps (the
// id a bubble and a row share), and whether it is a big trade.
export interface LogRow extends Sweep {
  readonly id: number
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
  for (let id = sweeps.length - 1; id >= 0; id--) {
    const sweep = sweeps[id]!
    if (DateTime.toEpochMillis(sweep.time) > options.at) continue
    if (!(yield* shown(sweep, options.threshold))) continue
    const big = yield* isBigSweep(sweep)
    if (options.bigOnly && !big) continue
    rows.push({ ...sweep, id, big })
  }
  return rows
})

// A sweep's average price: its value over its shares.
export const sweepPrice = (sweep: Sweep) =>
  Effect.sync(() => sweep.value / (sweep.lots * 100))

// The start of a sweep's minute, in epoch ms: its candle's.
export const sweepMinute = (sweep: Sweep) =>
  Effect.sync(
    () => Math.floor(DateTime.toEpochMillis(sweep.time) / MINUTE) * MINUTE
  )

// How far a bubble sits from its minute's centre, in pixels at `barSpacing`:
// its second within the minute, centred in that second.
export const bubbleOffset = (sweep: Sweep, barSpacing: number) =>
  Effect.sync(() => {
    const second = Math.floor(
      (DateTime.toEpochMillis(sweep.time) % MINUTE) / 1000
    )
    return ((second + 0.5) / 60 - 0.5) * barSpacing
  })

// A bubble's radius in CSS pixels: its area grows with lots, clamped so a
// 1-lot sweep stays visible and a block doesn't cover the chart.
export const bubbleRadius = (lots: number) =>
  Effect.sync(() => Math.max(1.5, Math.min(24, 0.25 * Math.sqrt(lots))))
