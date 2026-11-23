// The day's book events (spec apinrdw/kumora#517, "Book events"): what the
// level ledger found, held for the next delta, the next flush and the
// snapshots (event-log.ts).
import {
  EventOrder,
  MAX_CODE_BOOK_EVENTS,
  SNAPSHOT_BOOK_EVENTS,
} from "@workspace/relay"

import type { DayStore } from "./day-store.ts"
import { makeEventLog } from "./event-log.ts"

// While flushes keep failing, memory holds at most 10,000 events
// not stored yet (about 2 MB on node) and drops the oldest past that: the
// store misses them, a snapshot's newest don't. A busy code finds 1.74 a
// minute at the open (docs/research/book-event-thresholds.md), so even 900
// such codes take six failed flushes to fill it.
export const MAX_UNFLUSHED_EVENTS = 10_000

export const makeBookEventLog = (
  store: Pick<DayStore, "bookEventsOf" | "newestBookEvents">
) =>
  makeEventLog({
    order: EventOrder,
    snapshot: SNAPSHOT_BOOK_EVENTS,
    perCode: MAX_CODE_BOOK_EVENTS,
    maxUnflushed: MAX_UNFLUSHED_EVENTS,
    storedNewest: store.newestBookEvents,
    storedOf: store.bookEventsOf,
  })
