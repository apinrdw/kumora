import {
  TradeNumberOrder,
  wibDateAt,
  type StandoutLevel,
  type StandoutSweep,
  type ViewerDown,
  type WibDate,
} from "@workspace/relay"
import { Array as Arr, DateTime, Effect, Order } from "effect"

// The rows each picker level shows at most: the newest of the
// standout sweeps at or under it. At 10% a busy day across ~900 codes can
// decide tens of thousands, and the 10% rows would otherwise crowd the
// rarer 1% ones out of a list capped as one. See spec apinrdw/kumora#705.
const KEPT_PER_LEVEL = 500

const LEVELS: ReadonlyArray<StandoutLevel> = [1, 5, 10]

// A standout sweep's name for the day: its code and first trade's number.
export const standoutKey = ({ code, sweep }: StandoutSweep) =>
  `${code} ${sweep.firstTrade}`

const NewestFirst = Order.flip(
  Order.combine(
    Order.mapInput(Order.Number, ({ sweep }: StandoutSweep) =>
      DateTime.toEpochMillis(sweep.time)
    ),
    Order.mapInput(
      TradeNumberOrder,
      ({ sweep }: StandoutSweep) => sweep.firstTrade
    )
  )
)

// The rows that stay, newest first: each one among the newest
// KEPT_PER_LEVEL at or under its own level, so every level's list holds its
// newest KEPT_PER_LEVEL.
const trimmed = (rows: ReadonlyArray<StandoutSweep>) => {
  const seen = new Map<StandoutLevel, number>(LEVELS.map((level) => [level, 0]))
  return rows.filter((row) => {
    const kept = seen.get(row.level)! < KEPT_PER_LEVEL
    for (const level of LEVELS)
      if (level >= row.level) seen.set(level, seen.get(level)! + 1)
    return kept
  })
}

export interface StandoutStore {
  // The kept standout sweeps of every code, newest first.
  readonly rows: () => ReadonlyArray<StandoutSweep>
  readonly apply: (message: ViewerDown) => void
  readonly subscribe: (listener: () => void) => () => void
}

// The day's standout sweeps of every code from the live page's viewer
// socket, outside React. Each delta's join the list, each sweep once by
// `standoutKey`, the row already held kept: a reconnect's snapshot drops
// none. A snapshot of another WIB day starts the list again.
export const makeStandoutStore = Effect.sync((): StandoutStore => {
  let rows: ReadonlyArray<StandoutSweep> = []
  let keys = new Set<string>()
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
    keys = new Set()
    changed()
  }
  const add = (arriving: ReadonlyArray<StandoutSweep>) => {
    const fresh = arriving.filter((row) => !keys.has(standoutKey(row)))
    if (fresh.length === 0) return
    rows = trimmed(Arr.sort([...fresh, ...rows], NewestFirst))
    keys = new Set(rows.map(standoutKey))
    changed()
  }
  return {
    rows: () => rows,
    apply: (message) =>
      message._tag === "Snapshot"
        ? startDay(message.at)
        : add(message.standoutSweeps ?? []),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
})
