// The footprint chart's arithmetic (spec apinrdw/kumora#263, "Chart 2" and
// "Both charts"), apart from Lightweight Charts: chart 2 (footprint-canvas.tsx)
// works its bars out with these once per change, so its renderers only draw.
import type { Candle, Footprint } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { lots as exactLots, signed, tapeTime } from "./format"

// The IDX tick (fraksi harga) of a price.
export const idxTick = (price: number) =>
  Effect.succeed(
    price < 200
      ? 1
      : price < 500
        ? 2
        : price < 2_000
          ? 5
          : price < 5_000
            ? 10
            : 25
  )

// Lots as the footprint writes them: exact under 1,000, then always 2
// decimals with K, M or B. A figure that would round up to the next unit's
// 1,000.00 takes that unit: 999,995 lots read 1.00M.
export const shortLots = (lots: number) =>
  Effect.sync(() => {
    const size = Math.abs(lots)
    if (size < 1_000) return String(Math.round(lots))
    if (size < 999_995) return `${(lots / 1e3).toFixed(2)}K`
    if (size < 999_995_000) return `${(lots / 1e6).toFixed(2)}M`
    return `${(lots / 1e9).toFixed(2)}B`
  })

// One minute's totals: Vol counts every lot, auction matches' no-side lots
// included; buy, sell, Δ and the day's running CVD count only the lots with
// an aggressor side.
export interface MinuteTotals {
  readonly minute: number
  readonly volume: number
  readonly buy: number
  readonly sell: number
  readonly delta: number
  readonly cvd: number
}

// The totals of each footprint minute, ascending by minute as given.
export const minuteTotals = (footprints: ReadonlyArray<Footprint>) =>
  Effect.sync(() => {
    let cvd = 0
    return footprints.map((footprint): MinuteTotals => {
      let buy = 0
      let sell = 0
      let none = 0
      for (const cell of footprint.cells) {
        buy += cell.buy
        sell += cell.sell
        none += cell.none
      }
      cvd += buy - sell
      return {
        minute: DateTime.toEpochMillis(footprint.minute),
        volume: buy + sell + none,
        buy,
        sell,
        delta: buy - sell,
        cvd,
      }
    })
  })

// How a minute's column draws at `barSpacing` px a minute with rows
// `rowHeight` px tall: `sell × buy` text, compact text with no ×, split
// bars, or a plain candle. Text needs a row for its smallest font, 6 px.
export type DrawMode = "text" | "compact" | "bars" | "candles"

export const MIN_FONT_PX = 6

export const drawMode = (barSpacing: number, rowHeight: number) =>
  Effect.sync((): DrawMode => {
    if (barSpacing < 9 || rowHeight < 2) return "candles"
    if (barSpacing < 34 || rowHeight < MIN_FONT_PX + 1) return "bars"
    return barSpacing < 56 ? "compact" : "text"
  })

// Whether the footer writes each cell's label (`Vol`, `Δ`, `CVD`) beside its
// number, or the number alone.
export const footerLabelled = (barSpacing: number) =>
  Effect.succeed(barSpacing >= 76)

// The visible logical range that shows the last `count` whole bars of
// `bars`. Lightweight Charts 5.2.1 draws bars a…b of a range from a to b,
// both ends included, so `count` bars span a range `count - 1` wide.
export const windowOfLast = (bars: number, count: number) =>
  Effect.succeed({ from: bars - count, to: bars - 1 })

// One price of a minute's column, its texts ready to draw. `half` is half
// its tick: the row spans price ± half.
export interface FootprintRow {
  readonly price: number
  readonly half: number
  readonly sell: number
  readonly buy: number
  readonly none: number
  readonly sellText: string
  readonly buyText: string
  readonly noneText: string
}

// One minute of chart 2: its candle, its footprint rows ascending by price
// with the largest row's lots, and its footer figures with their texts.
// `later` marks a minute after a recorded day's replay cursor, drawn grey.
export interface FootprintColumn {
  readonly minute: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly later: boolean
  readonly rows: ReadonlyArray<FootprintRow>
  readonly most: number
  readonly totals: MinuteTotals
  readonly volumeText: string
  readonly deltaText: string
  readonly cvdText: string
}

const signedLots = Effect.fnUntraced(function* (lots: number) {
  const text = yield* shortLots(Math.abs(lots))
  return lots > 0 ? `+${text}` : lots < 0 ? `−${text}` : text
})

// Chart 2's columns: one per candle, with the footprint of its minute (none
// for a minute without one, as an index's). Minutes after `shownMinute` are
// later; CVD still runs over every minute of the day.
export const footprintColumns = Effect.fnUntraced(function* (
  candles: ReadonlyArray<Candle>,
  footprints: ReadonlyArray<Footprint>,
  shownMinute: number
) {
  const byMinute = new Map(
    footprints.map((footprint) => [
      DateTime.toEpochMillis(footprint.minute),
      footprint,
    ])
  )
  const totals = new Map(
    (yield* minuteTotals(footprints)).map((row) => [row.minute, row])
  )
  let cvd = 0
  const columns: Array<FootprintColumn> = []
  for (const candle of candles) {
    const minute = DateTime.toEpochMillis(candle.minute)
    const rows: Array<FootprintRow> = []
    let most = 0
    for (const cell of byMinute.get(minute)?.cells ?? []) {
      rows.push({
        ...cell,
        half: (yield* idxTick(cell.price)) / 2,
        sellText: yield* shortLots(cell.sell),
        buyText: yield* shortLots(cell.buy),
        noneText: yield* shortLots(cell.none),
      })
      most = Math.max(most, cell.sell + cell.buy + cell.none)
    }
    const figures: MinuteTotals = totals.get(minute) ?? {
      minute,
      volume: 0,
      buy: 0,
      sell: 0,
      delta: 0,
      cvd,
    }
    cvd = figures.cvd
    columns.push({
      minute,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      later: minute > shownMinute,
      rows,
      most,
      totals: figures,
      volumeText: yield* shortLots(figures.volume),
      deltaText: yield* signedLots(figures.delta),
      cvdText: yield* signedLots(figures.cvd),
    })
  }
  return columns
})

// Chart 2 in words, for a screen reader: how many footprint minutes there
// are up to `shownMinute`, and the exact Vol, Δ and CVD of the latest.
export const footprintSummary = Effect.fnUntraced(function* (
  footprints: ReadonlyArray<Footprint>,
  shownMinute: number
) {
  const totals = (yield* minuteTotals(footprints)).filter(
    (minute) => minute.minute <= shownMinute
  )
  const latest = totals.at(-1)
  const count = `Footprint minutes: ${totals.length}`
  if (latest === undefined) return count
  return `${count}. ${yield* tapeTime(latest.minute)}: Vol ${yield* exactLots(latest.volume)}, Δ ${yield* signed(latest.delta)}, CVD ${yield* signed(latest.cvd)}`
})
