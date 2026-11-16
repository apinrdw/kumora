// The footprint chart's two-line header (spec apinrdw/kumora#263, "Header
// readout"): one minute's whole picture in exact figures, the hovered one or
// the cursor's.
import { Effect } from "effect"

import type { FootprintColumn } from "./footprint"
import { direction, lots, plain, price, signed, tapeTime } from "./format"

// How a part is coloured: a side's tone, or one of the VWAP lines'.
export type HeaderTone =
  | "up"
  | "down"
  | "flat"
  | "vwap"
  | "band1"
  | "band2"
  | "band3"

export interface HeaderPart {
  readonly text: string
  readonly tone: HeaderTone
}

export type HeaderLine = ReadonlyArray<HeaderPart>

// Line 1: time, OHLC, lots and fills, Buy, Sell, Δ and CVD. Line 2: the
// day's VWAP so far, its ±1σ, ±2σ and ±3σ widths, and the POC. A minute after
// the cursor gives only its time.
export const footprintHeader = Effect.fnUntraced(function* (
  column: FootprintColumn
) {
  const part = (text: string, tone: HeaderTone = "flat"): HeaderPart => ({
    text,
    tone,
  })
  const time = (yield* tapeTime(column.minute)).slice(0, 5)
  if (column.later) return [[part(`${time} after the cursor`)]]
  const { buy, sell, delta, cvd } = column.totals
  const first: HeaderLine = [
    part(time),
    part(`O ${yield* price(column.open)}`),
    part(`H ${yield* price(column.high)}`),
    part(`L ${yield* price(column.low)}`),
    part(
      `C ${yield* price(column.close)}`,
      column.close >= column.open ? "up" : "down"
    ),
    part(
      `${yield* lots(column.volume)} lots, ${yield* lots(column.frequency)} fills`
    ),
    part(`Buy ${yield* lots(buy)}`, "up"),
    part(`Sell ${yield* lots(sell)}`, "down"),
    part(`Δ ${yield* signed(delta)}`, yield* direction(delta)),
    part(`CVD ${yield* signed(cvd)}`, yield* direction(cvd)),
  ]
  const { vwap, poc } = column
  const tenths = (n: number | undefined) =>
    n === undefined ? Effect.succeed("—") : plain(n, 1)
  const second: HeaderLine = [
    part(`VWAP ${yield* tenths(vwap?.mean)}`, "vwap"),
    part(`±1σ ${yield* tenths(vwap?.sigma)}`, "band1"),
    part(`±2σ ${yield* tenths(vwap && 2 * vwap.sigma)}`, "band2"),
    part(`±3σ ${yield* tenths(vwap && 3 * vwap.sigma)}`, "band3"),
    part(`POC ${poc === undefined ? "—" : yield* price(poc)}`),
  ]
  return [first, second]
})
