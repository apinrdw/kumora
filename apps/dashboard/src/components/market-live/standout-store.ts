import {
  keptStandouts,
  wibDateAt,
  type StandoutSweep,
  type ViewerDown,
  type WibDate,
} from "@workspace/relay"
import type { DateTime } from "effect"
import { Effect } from "effect"

export interface StandoutStore {
  // The kept standout sweeps of every code, newest first.
  readonly rows: () => ReadonlyArray<StandoutSweep>
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
// another WIB day starts the list again.
// Decision: each standout level keeps its newest 500 sweeps
// (packages/relay/docs/adr/0027-each-standout-level-keeps-its-newest-500-sweeps.md)
export const makeStandoutStore = Effect.sync((): StandoutStore => {
  let rows: ReadonlyArray<StandoutSweep> = []
  let day: WibDate | undefined
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
    changed()
  }
  const add = (arriving: ReadonlyArray<StandoutSweep>) => {
    const next = Effect.runSync(keptStandouts(rows, arriving))
    if (next === rows) return
    rows = next
    changed()
  }
  return {
    rows: () => rows,
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
