// Market Bubbles' backfill (spec apinrdw/kumora#427, "Backfill GET"): each
// stock code's day totals and newest BUBBLE_MINUTES candles, kept in memory
// as the candle book settles regular-board trades, and the answer built from
// them. An index's candles never settle a trade, so it has none.
import {
  BUBBLE_MINUTES,
  encodeRecordedBubbles,
  type RecordedBubbles,
  type StockCode,
} from "@workspace/relay"
import { Effect } from "effect"

import type { CandleFigures } from "./candles.ts"

// A day's figures: only the sums. The page's last price is the newest
// minute's close (lib/bubbles.ts, `lastPrice`), so the day keeps none.
export interface DaySums {
  readonly value: number
  readonly volume: number
  readonly frequency: number
  readonly buyValue: number
  readonly sellValue: number
}

// A minute's figures: its sums and its close.
export interface MinuteFigures extends DaySums {
  readonly close: number
}

// What the day store holds of them: every stock's day totals and its newest
// minutes (day-store.ts, `storedBubbles`).
export interface StoredBubbles {
  readonly days: ReadonlyArray<{
    readonly code: StockCode
    readonly sums: DaySums
  }>
  readonly minutes: ReadonlyArray<{
    readonly code: StockCode
    readonly minute: number
    readonly figures: MinuteFigures
  }>
}

interface CodeBubbles {
  day: DaySums
  // By minute, at most BUBBLE_MINUTES.
  readonly minutes: Map<number, MinuteFigures>
}

// A settle and its helpers (sumsOf, figuresOf, added, keepMinute, the
// book's `settled`) are plain functions, not Effects: the candle book calls
// it for each regular-board trade it settles, inside its own plain
// arithmetic (candles.ts). Measured 2026-11-16 on the dev machine: 100,000
// settles over 900 codes took 70 ms plain, 85 ms with one Effect each.
const sumsOf = (candle: CandleFigures): DaySums => ({
  value: candle.value,
  volume: candle.volume,
  frequency: candle.frequency,
  buyValue: candle.buyValue,
  sellValue: candle.sellValue,
})

const figuresOf = (candle: CandleFigures): MinuteFigures => ({
  ...sumsOf(candle),
  close: candle.close,
})

const added = (a: DaySums, b: DaySums): DaySums => ({
  value: a.value + b.value,
  volume: a.volume + b.volume,
  frequency: a.frequency + b.frequency,
  buyValue: a.buyValue + b.buyValue,
  sellValue: a.sellValue + b.sellValue,
})

// Keeps `minute` among a code's newest BUBBLE_MINUTES, unless it is older
// than all of a full set.
const keepMinute = (
  minutes: Map<number, MinuteFigures>,
  minute: number,
  figures: MinuteFigures
) => {
  if (minutes.has(minute) || minutes.size < BUBBLE_MINUTES) {
    minutes.set(minute, figures)
    return
  }
  const oldest = Math.min(...minutes.keys())
  if (minute < oldest) return
  minutes.delete(oldest)
  minutes.set(minute, figures)
}

// The day totals are a running sum, each settled trade added once,
// not a re-read of the day's candles, which a restart never loads; a restart
// rebuilds them once from the candles table (`restore`). A minute is its
// candle's settled figures, so a late trade replaces it. See spec
// apinrdw/kumora#427, "Where the day totals come from".
export const makeBubbleBook = Effect.sync(() => {
  const codes = new Map<StockCode, CodeBubbles>()

  // The day as the store held it, into a book that has settled nothing.
  const restore = (stored: StoredBubbles) =>
    Effect.sync(() => {
      for (const { code, sums } of stored.days)
        codes.set(code, { day: sums, minutes: new Map() })
      for (const { code, minute, figures } of stored.minutes)
        codes.get(code)?.minutes.set(minute, figures)
    })

  // A regular-board trade settled into its candle: `print` is the trade's own
  // figures, `candle` its minute's settled figures with it. Plain (the
  // comment at sumsOf).
  const settled = (
    code: StockCode,
    minute: number,
    candle: CandleFigures,
    print: CandleFigures
  ) => {
    const held = codes.get(code)
    if (held === undefined) {
      codes.set(code, {
        day: sumsOf(print),
        minutes: new Map([[minute, figuresOf(candle)]]),
      })
      return
    }
    held.day = added(held.day, sumsOf(print))
    keepMinute(held.minutes, minute, figuresOf(candle))
  }

  // The answer: every code, ascending, its minutes ascending, with the
  // previous close a `liveprice` frame carried, settled before
  // `settledBefore` (candles.ts).
  const build = (
    settledBefore: number,
    previousClose: (code: StockCode) => number | undefined
  ) =>
    Effect.suspend(() => {
      const answer: Array<RecordedBubbles["codes"][number]> = []
      for (const code of [...codes.keys()].sort()) {
        const { day, minutes } = codes.get(code)!
        const previous = previousClose(code)
        answer.push({
          code,
          ...(previous === undefined ? {} : { previousClose: previous }),
          day: [
            day.value,
            day.volume,
            day.frequency,
            day.buyValue,
            day.sellValue,
          ],
          minutes: [...minutes]
            .sort(([a], [b]) => a - b)
            .map(([minute, figures]) => [
              minute,
              figures.value,
              figures.volume,
              figures.frequency,
              figures.buyValue,
              figures.sellValue,
              figures.close,
            ]),
        })
      }
      return Effect.map(
        encodeRecordedBubbles({ settledBefore, codes: answer }),
        (text) => ({
          text,
          codes: answer.length,
        })
      )
    })

  // A code's regular-board value today in rupiah: 0 before its first
  // settled trade.
  const dayValue = (code: StockCode) =>
    Effect.sync(() => codes.get(code)?.day.value ?? 0)

  return { settled, build, dayValue, restore }
})
