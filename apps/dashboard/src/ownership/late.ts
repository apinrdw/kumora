import { isHoliday, SATURDAY, SUNDAY } from "@/relay/calendar"
import { WIB_MS } from "@/relay/trading-day"

import { asOfOfInstant, monthOfInstant } from "./as-of"
import type { AsOf, AsOfMonth } from "./as-of"
import type { Dataset } from "./csv"

/**
 * The spec's wire value on `GET /api/ownership/status`. `domain/freshness.ts` calls the same
 * idea `eod`; this one stays spelled as the published contract, and is not that type.
 */
export type OwnershipFreshness = "end-of-day" | "stale"

const DAY_MS = 24 * 3_600_000
/** A trading day's 5% file is not owed until this long into its WIB date. */
const CUTOFF_MS = 18.5 * 3_600_000
/** Last month's file is owed once the month is past this day. */
const LAST_MONTH_OWED_AFTER_DAY = 10

const isTradingDay = (shifted: number) => {
  const weekday = new Date(shifted).getUTCDay()
  return (
    weekday !== SATURDAY &&
    weekday !== SUNDAY &&
    !isHoliday(asOfOfInstant(shifted))
  )
}

const tradingDayBefore = (shifted: number) => {
  let day = shifted - DAY_MS
  while (!isTradingDay(day)) day -= DAY_MS
  return day
}

/** The trading day before the latest trading day whose 18:30 WIB has passed. */
const expectedDaily = (now: number) => {
  const cutoffPassedOn = now + WIB_MS - CUTOFF_MS
  return asOfOfInstant(
    tradingDayBefore(tradingDayBefore(cutoffPassedOn + DAY_MS))
  )
}

/** A month as `YYYY-MM`, because a monthly as-of counts by its month. */
const expectedMonthly = (now: number) => {
  const wib = new Date(now + WIB_MS)
  const monthsBack = wib.getUTCDate() > LAST_MONTH_OWED_AFTER_DAY ? 1 : 2
  return monthOfInstant(
    Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth() - monthsBack)
  )
}

export type ExpectedAsOf = AsOf | AsOfMonth

export const expectedAsOf = (dataset: Dataset, now: number): ExpectedAsOf =>
  dataset === "lima-persen" ? expectedDaily(now) : expectedMonthly(now)

/**
 * Compares as text: a date against a date, or a date against a month, where
 * `2026-09-29` is not older than `2026-09` and `2026-08-31` is.
 */
export const freshness = (
  asOf: AsOf | null,
  expected: ExpectedAsOf
): OwnershipFreshness =>
  asOf === null || asOf < expected ? "stale" : "end-of-day"
