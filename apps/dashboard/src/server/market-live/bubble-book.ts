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

// The figures the answer carries of a day or a minute: the sums, and the
// last price with the trade number it came from.
export interface BubbleFigures {
  readonly value: number
  readonly volume: number
  readonly frequency: number
  readonly buyValue: number
  readonly sellValue: number
  readonly close: number
  readonly closeOrder: bigint
}

// What the day store holds of them: every stock's day totals and its newest
// minutes (day-store.ts, `storedBubbles`).
export interface StoredBubbles {
  readonly days: ReadonlyArray<{
    readonly code: StockCode
    readonly figures: BubbleFigures
  }>
  readonly minutes: ReadonlyArray<{
    readonly code: StockCode
    readonly minute: number
    readonly figures: BubbleFigures
  }>
}

interface CodeBubbles {
  day: BubbleFigures
  // By minute, at most BUBBLE_MINUTES.
  readonly minutes: Map<number, BubbleFigures>
}

const figuresOf = (candle: CandleFigures): BubbleFigures => ({
  value: candle.value,
  volume: candle.volume,
  frequency: candle.frequency,
  buyValue: candle.buyValue,
  sellValue: candle.sellValue,
  close: candle.close,
  closeOrder: candle.closeOrder,
})

const added = (a: BubbleFigures, b: BubbleFigures): BubbleFigures => {
  const closes = b.closeOrder > a.closeOrder
  return {
    value: a.value + b.value,
    volume: a.volume + b.volume,
    frequency: a.frequency + b.frequency,
    buyValue: a.buyValue + b.buyValue,
    sellValue: a.sellValue + b.sellValue,
    close: closes ? b.close : a.close,
    closeOrder: closes ? b.closeOrder : a.closeOrder,
  }
}

// Keeps `minute` among a code's newest BUBBLE_MINUTES, unless it is older
// than all of a full set.
const keepMinute = (
  minutes: Map<number, BubbleFigures>,
  minute: number,
  figures: BubbleFigures
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

// Decision: the day totals are a running sum, each settled trade added once,
// not a re-read of the day's candles, which a restart never loads; a restart
// rebuilds them once from the candles table (`stored`). A minute is its
// candle's settled figures, so a late trade replaces it. See spec
// apinrdw/kumora#427, "Where the day totals come from".
export const makeBubbleBook = (stored: StoredBubbles) => {
  const codes = new Map<StockCode, CodeBubbles>()
  for (const { code, figures } of stored.days)
    codes.set(code, { day: figures, minutes: new Map() })
  for (const { code, minute, figures } of stored.minutes)
    codes.get(code)?.minutes.set(minute, figures)

  // A regular-board trade settled into its candle: `print` is the trade's own
  // figures, `candle` its minute's settled figures with it. A plain function,
  // as the candle arithmetic is (candles.ts).
  const settled = (
    code: StockCode,
    minute: number,
    candle: CandleFigures,
    print: CandleFigures
  ) => {
    const held = codes.get(code)
    if (held === undefined) {
      codes.set(code, {
        day: figuresOf(print),
        minutes: new Map([[minute, figuresOf(candle)]]),
      })
      return
    }
    held.day = added(held.day, figuresOf(print))
    keepMinute(held.minutes, minute, figuresOf(candle))
  }

  // The answer: every code, ascending, its minutes ascending, with the
  // previous close a `liveprice` frame carried.
  const build = (previousClose: (code: StockCode) => number | undefined) =>
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
            day.close,
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
      return Effect.map(encodeRecordedBubbles({ codes: answer }), (text) => ({
        text,
        codes: answer.length,
      }))
    })

  return { settled, build }
}
