import {
  keptStandouts,
  shownStandouts,
  wibDateAt,
  type StandoutLevel,
  type StandoutSweep,
  type ViewerDown,
  type WibDate,
} from "@workspace/relay"
import type { DateTime } from "effect"
import { Effect } from "effect"

export interface StandoutStore {
  // The standout sweeps of every code shown at `level`, newest first: the
  // same list until the rows change.
  readonly shown: (level: StandoutLevel) => ReadonlyArray<StandoutSweep>
  readonly apply: (message: ViewerDown) => void
  readonly subscribe: (listener: () => void) => () => void
}

// Decision: sweep alerts live only in object memory; the page keeps its marks
// (apps/dashboard/docs/adr/0087-sweep-alerts-live-only-in-the-object-s-memory.md)
//
// The day's standout sweeps of every code from the live page's viewer
// socket, outside React. A snapshot's and each delta's join the list, each
// sweep once by `standoutKey`, the row already held kept: a reconnect drops
// none, even to an object restarted with an empty backlog. A snapshot of
// another WIB day starts the list again. The list holds what every level
// shows, so the page asks for one level's rows, never the list.
// Decision: each standout level keeps its newest 500 sweeps
// (packages/relay/docs/adr/0027-each-standout-level-keeps-its-newest-500-sweeps.md)
export const makeStandoutStore = Effect.sync((): StandoutStore => {
  let rows: ReadonlyArray<StandoutSweep> = []
  let day: WibDate | undefined
  // `shown`'s answer per level for the current `rows`.
  let shown = new Map<StandoutLevel, ReadonlyArray<StandoutSweep>>()
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of listeners) listener()
  }
  const startDay = (at: DateTime.Utc) => {
    const today = Effect.runSync(wibDateAt(at))
    const another = day !== undefined && today !== day
    day = today
    if (!another) return
    rows = []
    shown = new Map()
    changed()
  }
  const add = (arriving: ReadonlyArray<StandoutSweep>) => {
    const next = Effect.runSync(keptStandouts(rows, arriving))
    if (next === rows) return
    rows = next
    shown = new Map()
    changed()
  }
  return {
    shown: (level) => {
      const held = shown.get(level)
      if (held !== undefined) return held
      const rowsAt = Effect.runSync(shownStandouts(rows, level))
      shown.set(level, rowsAt)
      return rowsAt
    },
    apply: (message) => {
      if (message._tag === "Snapshot") startDay(message.at)
      add(message.standoutSweeps ?? [])
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
})
