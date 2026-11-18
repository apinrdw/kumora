// The day's book events (spec apinrdw/kumora#517, "Book events"): what the
// level ledger found, held for the next delta, the next flush and the
// snapshots. The day store keeps every flushed one; memory keeps the newest
// SNAPSHOT_BOOK_EVENTS and the ones not stored yet.
import {
  SNAPSHOT_BOOK_EVENTS,
  type BookEvent,
  type StockCode,
} from "@workspace/relay"
import { Effect } from "effect"

import type { DayStore } from "./day-store.ts"

export const makeBookEventLog = (
  store: Pick<DayStore, "bookEventsOf" | "newestBookEvents">
) =>
  Effect.gen(function* () {
    // A restarted object's snapshots still carry the day's newest.
    let newest: Array<BookEvent> = [
      ...(yield* store.newestBookEvents(SNAPSHOT_BOOK_EVENTS)),
    ]
    let pending: Array<BookEvent> = []
    let unflushed: Array<BookEvent> = []

    const add = (events: ReadonlyArray<BookEvent>) =>
      Effect.sync(() => {
        if (events.length === 0) return
        pending.push(...events)
        unflushed.push(...events)
        newest = [...newest, ...events].slice(-SNAPSHOT_BOOK_EVENTS)
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

    // One code's events for the day so far, stored and not.
    const ofCode = Effect.fnUntraced(function* (code: StockCode) {
      return [
        ...(yield* store.bookEventsOf(code)),
        ...unflushed.filter((event) => event.code === code),
      ]
    })

    return {
      add,
      takeDelta,
      toFlush,
      written,
      ofCode,
      newest: Effect.sync(() => newest),
    }
  })
