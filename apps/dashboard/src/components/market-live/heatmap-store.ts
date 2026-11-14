import {
  HEAT_SLICE_MS,
  type HeatSlice,
  type RecordedHeatmap,
  type StockCode,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { heatSlices, type BookChange } from "@/lib/heatmap"

export interface HeatmapStore {
  readonly code: StockCode
  // The selected code's slices, ascending.
  readonly slices: () => ReadonlyArray<HeatSlice>
  // The heatmap GET's answer. A live day's goes on from the slice time it
  // names, built from the books this store hears; a recorded day's is whole.
  readonly seed: (answer: RecordedHeatmap, live?: boolean) => void
  readonly apply: (message: ViewerDown) => void
  // A new slice may have started: it is built from the book in force.
  readonly tick: () => void
  readonly subscribe: (listener: () => void) => () => void
}

// The selected code's book heatmap outside React, like the candle store:
// chart 1 reads it once when it mounts and then hears each change. On a live
// day the slices up to the GET's join come from the Durable Object, and the
// ones from it on are weighed here from the books the viewer socket sends,
// each in force from when it arrived; the current slice is weighed as if its
// book holds to the slice's end.
// Decision: "when it arrived" is on the object's clock, not the browser's,
// which can run minutes off it (and does on the Test stage). The store keeps
// the browser's clock (`now`) plus the largest offset seen from an instant
// the object had passed when it was heard: the GET's join and each book's
// as-of. See spec apinrdw/kumora#263, "Viewer protocol".
export const makeHeatmapStore = (
  code: StockCode,
  now: () => number = () => Date.now()
) =>
  Effect.sync((): HeatmapStore => {
    // Slices that can't change any more, then the current one.
    let settled: Array<HeatSlice> = []
    let shown: ReadonlyArray<HeatSlice> = []
    // Where the slices built here start: the GET's join, then the current
    // slice. None until a live day's GET answers.
    let from: number | undefined
    let live = true
    // The books heard, ascending: from the one in force at `from` on.
    let changes: Array<BookChange> = []
    // The index of the last book heard at or before `at`; -1 for none.
    const inForceAt = (at: number) => {
      let index = changes.length - 1
      while (index >= 0 && changes[index]!.at > at) index--
      return index
    }
    let offset: number | undefined
    // `at` on the object's clock had passed by now.
    const passed = (at: number) => {
      const seen = at - now()
      if (offset === undefined || seen > offset) offset = seen
    }
    const objectNow = () => now() + (offset ?? 0)
    const listeners = new Set<() => void>()
    const emit = () => {
      for (const listener of listeners) listener()
    }
    const rebuild = () => {
      if (from === undefined) return
      const current = Math.floor(objectNow() / HEAT_SLICE_MS) * HEAT_SLICE_MS
      const built = Effect.runSync(
        heatSlices(changes, from, Math.max(from, current) + HEAT_SLICE_MS)
      )
      const settling = built.filter(
        (slice) => DateTime.toEpochMillis(slice.at) < current
      )
      settled = [...settled, ...settling]
      shown = [...settled, ...built.slice(settling.length)]
      if (current > from) {
        from = current
        const inForce = inForceAt(current)
        if (inForce > 0) changes = changes.slice(inForce)
      }
      emit()
    }
    const hear = (message: ViewerDown) => {
      const held =
        message._tag === "Snapshot"
          ? message.selected === code && message.orderBook?._tag === "OrderBook"
            ? message.orderBook
            : undefined
          : message.orderBooks?.find((book) => book.code === code)
      if (held === undefined || !live) return
      passed(DateTime.toEpochMillis(held.at))
      changes.push({ at: objectNow(), book: held })
      rebuild()
    }
    return {
      code,
      slices: () => shown,
      seed: (answer, isLive = true) => {
        live = isLive
        settled = [...answer.slices]
        shown = settled
        if (live) {
          const through = DateTime.toEpochMillis(answer.through)
          passed(through)
          from = through
          // The books heard before the answer: the one in force at the join,
          // the earliest standing in for any before it.
          changes = changes.slice(Math.max(0, inForceAt(through)))
          if (changes[0] !== undefined && changes[0].at > through)
            changes[0] = { ...changes[0], at: through }
          rebuild()
        } else {
          changes = []
          emit()
        }
      },
      apply: hear,
      tick: () => {
        if (from !== undefined && objectNow() >= from + HEAT_SLICE_MS) rebuild()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    }
  })
