// Market Bubbles' header strip (spec apinrdw/kumora#427, "The header
// strip"): the day's regular-board value and frequency over every code, the
// up / down / unchanged counts, and IHSG's change.
import type { RecordedDay, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { lastPrice, type MarketFlow } from "@/lib/bubbles"

export interface MarketStrip {
  readonly value: number
  readonly frequency: number
  readonly up: number
  readonly down: number
  readonly unchanged: number
}

// The day so far over every code `flow` holds. A code counts up, down or
// unchanged against its previous close; one with none known, or with no
// last price yet, is left out of the counts.
export const marketStrip = (flow: MarketFlow) =>
  Effect.sync((): MarketStrip => {
    let value = 0
    let frequency = 0
    let up = 0
    let down = 0
    let unchanged = 0
    for (const code of flow.codes.values()) {
      const { day, previousClose } = code
      value += day.value
      frequency += day.frequency
      const last = lastPrice(code)
      if (day.frequency === 0 || previousClose === undefined) continue
      if (last === undefined) continue
      if (last > previousClose) up++
      else if (last < previousClose) down++
      else unchanged++
    }
    return { value, frequency, up, down, unchanged }
  })

// IHSG's change % at `last`, against the newest sealed day before `today`
// whose IHSG close the day strip recorded. An IHSG frame carries no previous
// close (trading-day.ts), so the strip is the only source; none without it.
export const ihsgChange = (
  last: number,
  days: ReadonlyArray<RecordedDay>,
  today: WibDate
) =>
  Effect.sync(() => {
    let newest: RecordedDay | undefined
    for (const day of days)
      if (
        day.day < today &&
        day.ihsg !== undefined &&
        (newest === undefined || day.day > newest.day)
      )
        newest = day
    const close = newest?.ihsg?.close
    return close === undefined || close === 0
      ? undefined
      : ((last - close) / close) * 100
  })
