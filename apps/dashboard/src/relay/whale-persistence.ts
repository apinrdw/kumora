// How the whale state outlives the object's memory: the sketches flushed, the rest
// rebuilt from a bounded stretch of the tape, and one session handing on to the next.
// Synchronous like the store, so each of these commits as one event.
import type { Symbol } from "@/domain/symbol"
import type { IsoDateTime } from "@/domain/time"
import type { Trade } from "@/domain/trade"

import type { RelayStore } from "./store"
import { MARKET_SKETCH } from "./whale-store"
import {
  closeAll,
  closeIdle,
  createWhales,
  feedTrades,
  marketSketch,
  notInSketch,
  whaleReplayFrom,
} from "./whale"
import type { WhaleState } from "./whale"

/** The batch a rebuild starts from, stored by a wake that finds none and with each flush. */
export const WHALE_REPLAY_KEY = "whaleReplayFrom"

/** Writes what changed since the last flush. Returns the `whaleReplayFrom` to store with it. */
export const flushWhales = (
  store: RelayStore,
  whales: WhaleState,
  day: string,
  seq: number
) => {
  if (whales.dirty.size > 0) {
    for (const symbol of whales.dirty) {
      const sketch = whales.sketches.get(symbol)
      if (sketch) store.upsertSketch(symbol, day, sketch)
    }
    store.upsertSketch(
      MARKET_SKETCH,
      day,
      marketSketch(whales.sketches.values())
    )
    whales.dirty.clear()
  }
  return whaleReplayFrom(whales, seq)
}

type Batch = { receivedAt: IsoDateTime; trades: Array<Trade> }

/** Every batch since `from`, put back together in order from its symbols' rows. */
const batchesFrom = (
  store: RelayStore,
  symbols: ReadonlyArray<Symbol>,
  from: number
) => {
  const batches = new Map<number, Batch>()
  for (const symbol of symbols)
    for (const { seq, receivedAt, trades } of store.tapeFrom(symbol, from)) {
      const batch = batches.get(seq)
      if (batch) batch.trades.push(...trades)
      else batches.set(seq, { receivedAt, trades })
    }
  return [...batches].sort(([a], [b]) => a - b)
}

/**
 * Today's state from its rows and the batches since `from`, run as the batch path
 * ran them: feed, then the idle close at that batch's arrival. `symbols` are the ones
 * traded since `from`. It sends nothing, and its upserts land on the rows' own keys.
 */
export const rebuildWhales = (
  store: RelayStore,
  day: string,
  symbols: ReadonlyArray<Symbol>,
  from: number
) => {
  const whales = createWhales(
    store.priorSketches(day),
    store.sessionSketches(day).own
  )
  for (const [seq, { receivedAt, trades }] of batchesFrom(store, symbols, from))
    for (const { sweeps } of [
      feedTrades(whales, notInSketch(whales, trades), seq),
      closeIdle(whales, Date.parse(receivedAt), seq),
    ])
      for (const sweep of sweeps) store.upsertSweep(sweep)
  return whales
}

/**
 * Closes the ended session into its sketches, keeps them as the prior and deletes the
 * older ones. Returns the new session's empty state. The caller drops the rows.
 */
export const endWhaleSession = (
  store: RelayStore,
  whales: WhaleState,
  ended: string,
  next: string,
  seq: number
) => {
  closeAll(whales, new Date().toISOString() as IsoDateTime, seq)
  flushWhales(store, whales, ended, seq)
  store.deleteOlderSketches()
  return createWhales(store.priorSketches(next))
}
