// The day's book events (spec apinrdw/kumora#517, "Book events"): what the
// level ledger found, held for the next delta, the next flush and the
// snapshots. The day store keeps every flushed one; memory keeps the ones
// not stored yet, at most MAX_UNFLUSHED_EVENTS of them, and the newest
// SNAPSHOT_BOOK_EVENTS from the first snapshot on.
import {
  BookEventOrder,
  MAX_CODE_BOOK_EVENTS,
  SNAPSHOT_BOOK_EVENTS,
  type BookEvent,
  type StockCode,
} from "@workspace/relay"
import { Array as Arr, Effect } from "effect"

import type { DayStore } from "./day-store.ts"

// Decision: while flushes keep failing, memory holds at most 10,000 events
// not stored yet (about 2 MB on node) and drops the oldest past that: the
// store misses them, a snapshot's newest don't. A busy code finds 1.74 a
// minute at the open (docs/research/book-event-thresholds.md), so even 900
// such codes take six failed flushes to fill it.
export const MAX_UNFLUSHED_EVENTS = 10_000

export const makeBookEventLog = (
  store: Pick<DayStore, "bookEventsOf" | "newestBookEvents">
) =>
  Effect.sync(() => {
    // The day's newest SNAPSHOT_BOOK_EVENTS, none until a snapshot asks.
    let newest: Array<BookEvent> | undefined
    let pending: Array<BookEvent> = []
    let unflushed: Array<BookEvent> = []

    const add = (events: ReadonlyArray<BookEvent>) =>
      Effect.sync(() => {
        if (events.length === 0) return
        pending.push(...events)
        unflushed.push(...events)
        if (unflushed.length > MAX_UNFLUSHED_EVENTS)
          unflushed = unflushed.slice(-MAX_UNFLUSHED_EVENTS)
        if (newest !== undefined)
          newest = Arr.sort([...newest, ...events], BookEventOrder).slice(
            -SNAPSHOT_BOOK_EVENTS
          )
      })

    // Decision: the store's newest are read when a snapshot first asks, not
    // as the object starts, so a restarted object's snapshots still carry
    // them and an object that sends none never reads them. The read visits
    // every book event of the day (day-store.ts, `newestBookEvents`), and a
    // sealed day's object starts again at each of the page's 30 s rechecks:
    // at 24,000 events each start read 48,010 rows, now 10
    // (row-budgets.workerd.test.ts).
    const newestOnce = Effect.gen(function* () {
      if (newest !== undefined) return newest
      const stored = yield* store.newestBookEvents(SNAPSHOT_BOOK_EVENTS)
      newest = Arr.sort([...stored, ...unflushed], BookEventOrder).slice(
        -SNAPSHOT_BOOK_EVENTS
      )
      return newest
    })

    // The events found since the last delta.
    const takeDelta = Effect.sync(() => {
      const taken = pending
      pending = []
      return taken
    })

    // The events a flush writes; `written` drops them once it landed, so a
    // failed flush's are written by the next.
    const toFlush = Effect.sync(() => [...unflushed])
    const written = (count: number) =>
      Effect.sync(() => {
        unflushed = unflushed.slice(count)
      })

    // One code's newest MAX_CODE_BOOK_EVENTS for the day so far, stored and
    // not, oldest first.
    const ofCode = Effect.fnUntraced(function* (code: StockCode) {
      return Arr.sort(
        [
          ...(yield* store.bookEventsOf(code)),
          ...unflushed.filter((event) => event.code === code),
        ],
        BookEventOrder
      ).slice(-MAX_CODE_BOOK_EVENTS)
    })

    return {
      add,
      takeDelta,
      toFlush,
      written,
      ofCode,
      newest: newestOnce,
    }
  })
