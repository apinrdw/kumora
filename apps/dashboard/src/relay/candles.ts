// A symbol's minute candles and volume profile as a pure fold of its tape, which the relay runs when a
// page opens and the browser carries on from live frames, so both give one answer.
// No `effect` here, and the domain only as types.
import type { IsoDateTime } from "@/domain/time"
import type {
  CandleFold,
  MinuteCandle,
  ProfileLevel,
  Trade,
} from "@/domain/trade"

import { REGULAR_BOARD, SHARES_PER_LOT } from "./exchange"

/** A candle is a minute of trades; longer periods are whole minutes. */
export const MINUTE_MS = 60_000

export const NO_CANDLES: CandleFold = {
  lastNumber: 0,
  candles: [],
  profile: [],
}

const byPrice = (a: ProfileLevel, b: ProfileLevel) => a.price - b.price

/** WIB is a whole number of hours from UTC, so a floor in UTC is a floor in WIB up to an hour. */
const periodStart = (ms: number, periodMs: number) =>
  Math.floor(ms / periodMs) * periodMs

const isoOf = (ms: number) => new Date(ms).toISOString() as IsoDateTime

const byTime = (a: MinuteCandle, b: MinuteCandle) => a.at.localeCompare(b.at)

/**
 * Adds trades above `lastNumber`, so a resend changes nothing. Only the regular board moves a
 * candle or the profile, and a late trade lands on its own minute. Takes batches lazily and
 * holds one candle per minute and one level per price, so a whole day's tape costs a session's
 * minutes and its range.
 */
export const foldCandles = (
  held: CandleFold,
  batches: Iterable<ReadonlyArray<Trade>>
): CandleFold => {
  const byMinute = new Map(held.candles.map((c) => [c.at, c]))
  const levels = new Map(held.profile.map((l) => [l.price, { ...l }]))
  let { lastNumber } = held
  for (const batch of batches)
    for (const { board, price, volume, side, tradeNumber, tradedAt } of batch) {
      if (tradeNumber <= lastNumber) continue
      lastNumber = tradeNumber
      if (board !== REGULAR_BOARD) continue
      const at = isoOf(periodStart(Date.parse(tradedAt), MINUTE_MS))
      const lots = volume / SHARES_PER_LOT
      const candle = byMinute.get(at)
      byMinute.set(
        at,
        candle
          ? {
              at,
              open: candle.open,
              high: Math.max(candle.high, price),
              low: Math.min(candle.low, price),
              close: price,
              lots: candle.lots + lots,
            }
          : { at, open: price, high: price, low: price, close: price, lots }
      )
      const level = levels.get(price) ?? {
        price,
        buy: 0,
        sell: 0,
        unspecified: 0,
      }
      level[side] += lots
      levels.set(price, level)
    }
  return {
    lastNumber,
    candles: [...byMinute.values()].sort(byTime),
    profile: [...levels.values()].sort(byPrice),
  }
}

/** Minute candles, oldest first, merged into a longer period. */
export const candlesOfPeriod = (
  minutes: ReadonlyArray<MinuteCandle>,
  periodMs: number
): ReadonlyArray<MinuteCandle> => {
  const merged = new Map<IsoDateTime, MinuteCandle>()
  for (const { open, high, low, close, lots, at: minute } of minutes) {
    const at = isoOf(periodStart(Date.parse(minute), periodMs))
    const candle = merged.get(at)
    merged.set(
      at,
      candle
        ? {
            at,
            open: candle.open,
            high: Math.max(candle.high, high),
            low: Math.min(candle.low, low),
            close,
            lots: candle.lots + lots,
          }
        : { at, open, high, low, close, lots }
    )
  }
  return [...merged.values()]
}

/** The start of the period an instant falls in. */
export const periodOf = (iso: string, periodMs: number) =>
  isoOf(periodStart(Date.parse(iso), periodMs))
