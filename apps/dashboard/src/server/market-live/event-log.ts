// A day's events of one kind, book events (book-event-log.ts) or order flow
// events (order-flow-event-log.ts): what the object found, held for the next
// delta, the next flush and the snapshots. The day store keeps every flushed
// one; memory keeps the ones not stored yet, at most `maxUnflushed` of them,
// and the day's newest `snapshot` from the first snapshot on.
import type { StockCode } from "@workspace/relay"
import { Array as Arr, Effect, type Order } from "effect"

interface Event {
  readonly code: StockCode
}

export const makeEventLog = <E extends Event>(options: {
  readonly order: Order.Order<E>
  // How many of the day's newest a snapshot carries, and of one code's.
  readonly snapshot: number
  readonly perCode: number
  readonly maxUnflushed: number
  // The day's newest `limit` stored, and one code's newest `perCode`, each
  // oldest first.
  readonly storedNewest: (limit: number) => Effect.Effect<ReadonlyArray<E>>
  readonly storedOf: (code: StockCode) => Effect.Effect<ReadonlyArray<E>>
}) =>
  Effect.sync(() => {
    const { order, snapshot, perCode, maxUnflushed } = options
    // The day's newest `snapshot`, none until a snapshot asks.
    let newest: Array<E> | undefined
    let pending: Array<E> = []
    let unflushed: Array<E> = []

    const keep = (events: ReadonlyArray<E>) =>
      Effect.sync(() => {
        unflushed.push(...events)
        if (unflushed.length > maxUnflushed)
          unflushed = unflushed.slice(-maxUnflushed)
        if (newest !== undefined)
          newest = Arr.sort([...newest, ...events], order).slice(-snapshot)
      })

    const add = (events: ReadonlyArray<E>) =>
      Effect.suspend(() => {
        if (events.length === 0) return Effect.void
        pending.push(...events)
        return keep(events)
      })

    // Events found again after a restart that the store lacks: kept for the
    // next flush and the snapshots, never sent in a delta.
    const restore = keep

    // Decision: the store's newest are read when a snapshot first asks, not
    // as the object starts: the read visits every event of the day
    // (day-store.ts, `newestBookEvents`), and a sealed day's object starts at
    // each of the page's 30 s rechecks and sends no snapshot. At 24,000
    // events a start read 48,010 rows, now 10 (row-budgets.workerd.test.ts).
    const newestOnce = Effect.gen(function* () {
      if (newest !== undefined) return newest
      const stored = yield* options.storedNewest(snapshot)
      newest = Arr.sort([...stored, ...unflushed], order).slice(-snapshot)
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

    // One code's newest `perCode` for the day so far, stored and not, oldest
    // first.
    const ofCode = Effect.fnUntraced(function* (code: StockCode) {
      return Arr.sort(
        [
          ...(yield* options.storedOf(code)),
          ...unflushed.filter((event) => event.code === code),
        ],
        order
      ).slice(-perCode)
    })

    return {
      add,
      restore,
      takeDelta,
      toFlush,
      written,
      ofCode,
      newest: newestOnce,
    }
  })
