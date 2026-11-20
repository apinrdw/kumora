import {
  EventOrder,
  wibDateAt,
  type StockCode,
  type ViewerDown,
  type WibDate,
} from "@workspace/relay"
import { Array as Arr, DateTime, Effect, Order } from "effect"

import { eventKey } from "@/lib/book-events"
import type { MarketEvent } from "@/lib/order-flow-events"
import { RECENT_EVENTS_MS, type CodeEvents } from "@/lib/order-book-radar"

// Decision: the scanner keeps every book and order flow event of the last
// 5 minutes, for Events in 5 minutes, and at least the newest 200, for the
// feed; each code's newest stays for Last event however old. A busy open can
// find a few hundred a minute. See spec apinrdw/kumora#517 and
// apinrdw/kumora#605.
const KEPT_EVENTS = 200

const NewestFirst = Order.flip(EventOrder)

export interface RadarEventsStore {
  // The kept events, newest first.
  readonly events: () => ReadonlyArray<MarketEvent>
  // Each code's newest event and its count of the RECENT_EVENTS_MS before
  // `now`, on the object's clock.
  readonly byCode: (now: number) => ReadonlyMap<StockCode, CodeEvents>
  readonly apply: (message: ViewerDown) => void
  readonly subscribe: (listener: () => void) => () => void
}

// Every code's book and order flow events from the scanner's viewer socket,
// outside React. Each snapshot's newest 100 of each across the market and
// each delta's join the
// list, in time order, each event once: a row unfolded or folded sends a
// Select, whose snapshot must not drop the events already seen. A snapshot
// of another WIB day starts the list again.
export const makeRadarEventsStore = Effect.sync((): RadarEventsStore => {
  let events: ReadonlyArray<MarketEvent> = []
  let keys = new Set<string>()
  let latest = new Map<StockCode, MarketEvent>()
  let day: WibDate | undefined
  const listeners = new Set<() => void>()
  const add = (arriving: ReadonlyArray<MarketEvent>, now: number) => {
    const fresh = arriving.filter(
      (event) => !keys.has(Effect.runSync(eventKey(event)))
    )
    if (fresh.length === 0) return false
    for (const event of fresh) {
      const held = latest.get(event.code)
      if (held === undefined || EventOrder(held, event) <= 0)
        latest.set(event.code, event)
    }
    events = Arr.sort([...fresh, ...events], NewestFirst).filter(
      (event, index) =>
        index < KEPT_EVENTS ||
        now - DateTime.toEpochMillis(event.at) < RECENT_EVENTS_MS
    )
    keys = new Set(events.map((event) => Effect.runSync(eventKey(event))))
    return true
  }
  return {
    events: () => events,
    byCode: (now) => {
      const counts = new Map<StockCode, number>()
      for (const event of events) {
        const age = now - DateTime.toEpochMillis(event.at)
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
      const snapshot = message._tag === "Snapshot"
      if (snapshot) {
        const today = Effect.runSync(wibDateAt(message.at))
        if (today !== day) {
          day = today
          events = []
          keys = new Set()
          latest = new Map()
        }
      }
      const added = add(
        [...(message.bookEvents ?? []), ...(message.orderFlowEvents ?? [])],
        now
      )
      if (snapshot || added) for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
})
