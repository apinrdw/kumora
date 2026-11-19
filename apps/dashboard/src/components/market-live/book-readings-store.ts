import type { BookReadings, StockCode, ViewerDown } from "@workspace/relay"
import { Clock, DateTime, Effect } from "effect"

export interface BookReadingsStore {
  // A code's latest readings, or none yet.
  readonly readingsOf: (code: StockCode) => BookReadings | undefined
  // Every code's latest readings.
  readonly all: () => ReadonlyArray<BookReadings>
  // The trading-day object's clock now, in epoch ms, as its last message's
  // send time read it.
  readonly now: Effect.Effect<number>
  readonly apply: (message: ViewerDown) => void
  readonly subscribe: (listener: () => void) => () => void
}

// Every code's latest book readings from the viewer socket, outside React. A
// snapshot carries every code's whatever it selected, so it replaces them
// all; a delta's readings replace their codes'.
export const makeBookReadingsStore = Effect.sync((): BookReadingsStore => {
  let held = new Map<StockCode, BookReadings>()
  // The object's clock less this one's, at its last message.
  let skew = 0
  const listeners = new Set<() => void>()
  const tell = () => {
    for (const listener of listeners) listener()
  }
  return {
    readingsOf: (code) => held.get(code),
    all: () => [...held.values()],
    now: Clock.currentTimeMillis.pipe(Effect.map((local) => local + skew)),
    apply: (message) => {
      skew = DateTime.toEpochMillis(message.at) - Date.now()
      const arriving = message.bookReadings ?? []
      if (message._tag === "Snapshot") {
        held = new Map(arriving.map((readings) => [readings.code, readings]))
        return tell()
      }
      if (arriving.length === 0) return
      for (const readings of arriving) held.set(readings.code, readings)
      tell()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
})
