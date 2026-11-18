import type { BookEvent, StockCode, ViewerDown } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { RECENT_EVENTS_MS, type CodeEvents } from "@/lib/order-book-radar"

// Decision: the scanner keeps every book event of the last 5 minutes, for
// Events in 5 minutes, and at least the newest 200, for the feed; each
// code's newest stays for Last event however old. A busy open can find a
// few hundred a minute across the market. See spec apinrdw/kumora#517,
// "Book events".
const KEPT_EVENTS = 200

export interface RadarEventsStore {
  // The kept events, newest first.
  readonly events: () => ReadonlyArray<BookEvent>
  // Each code's newest event and its count of the RECENT_EVENTS_MS before
  // `now`, on the object's clock.
  readonly byCode: (now: number) => ReadonlyMap<StockCode, CodeEvents>
  readonly apply: (message: ViewerDown) => void
  readonly subscribe: (listener: () => void) => () => void
}

const atOf = (event: BookEvent) => DateTime.toEpochMillis(event.at)

// Every code's book events from the scanner's viewer socket, outside React:
// a snapshot's newest 100 across the market start the list again, and each
// delta's add to it.
export const makeRadarEventsStore = Effect.sync((): RadarEventsStore => {
  let events: ReadonlyArray<BookEvent> = []
  let latest = new Map<StockCode, BookEvent>()
  const listeners = new Set<() => void>()
  const add = (arriving: ReadonlyArray<BookEvent>, now: number) => {
    const newestFirst = [...arriving].sort((a, b) => atOf(b) - atOf(a))
    for (const event of [...newestFirst].reverse()) {
      const held = latest.get(event.code)
      if (held === undefined || atOf(held) <= atOf(event))
        latest.set(event.code, event)
    }
    events = [...newestFirst, ...events].filter(
      (event, index) =>
        index < KEPT_EVENTS || now - atOf(event) < RECENT_EVENTS_MS
    )
  }
  return {
    events: () => events,
    byCode: (now) => {
      const counts = new Map<StockCode, number>()
      for (const event of events) {
        const age = now - atOf(event)
        if (age >= 0 && age < RECENT_EVENTS_MS)
          counts.set(event.code, (counts.get(event.code) ?? 0) + 1)
      }
      return new Map(
        [...latest].map(([code, last]) => [
          code,
          { last, inFiveMinutes: counts.get(code) ?? 0 },
        ])
      )
    },
    apply: (message) => {
      const now = DateTime.toEpochMillis(message.at)
      if (message._tag === "Snapshot") {
        events = []
        latest = new Map()
        add(message.bookEvents ?? [], now)
      } else if ((message.bookEvents ?? []).length > 0)
        add(message.bookEvents ?? [], now)
      else return
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
})
