// One symbol on the live page: the tape store with candles and source changes alongside.
// No `effect` here, and the domain only as types.
import { useMemo, useSyncExternalStore } from "react"

import type { Symbol } from "@/domain/symbol"
import type { CandleFold, LiveSymbol, TapeCoverage } from "@/domain/trade"
import { createRelayStore } from "./relay-store"
import type { RelayEvent } from "./relay-store"
import { mergeOffBoard, reduceTape, tapeState } from "./tape"
import type { TapeState } from "./tape"
import { NO_CANDLES, foldCandles } from "@/relay/candles"

import { liveSymbolQuery, relayTicket } from "./query"

export type LiveSymbolState = {
  readonly seq: number
  readonly tape: TapeState
  readonly candles: CandleFold
  /** The relay's record of its source, oldest first: the backfill's, then each status frame's. */
  readonly coverage: ReadonlyArray<TapeCoverage>
}

export const liveSymbolState = ({
  backfill,
  candles,
}: LiveSymbol): LiveSymbolState => ({
  seq: backfill.seq,
  tape: tapeState(backfill),
  candles,
  coverage: backfill.coverage,
})

export const reduceLiveSymbol = (
  state: LiveSymbolState,
  event: RelayEvent
): LiveSymbolState => {
  const tape = reduceTape(state.tape, event)
  const newDay =
    state.tape.day !== null && tape.day !== null && tape.day > state.tape.day
  const candles = newDay ? NO_CANDLES : state.candles
  const frame = event.type === "frame" ? event.frame : null
  return {
    seq: tape.seq,
    tape,
    candles:
      frame?.type === "trades" ? foldCandles(candles, [frame.trades]) : candles,
    coverage: frame?.type === "status" ? frame.status.coverage : state.coverage,
  }
}

/**
 * The relay's candles and off-board trades again, after a reconnect whose capped resume can leave
 * holes. Trades the page heard past them fold back on, and an answer of another day changes nothing.
 */
export const refold = (
  state: LiveSymbolState,
  fresh: LiveSymbol
): LiveSymbolState => {
  const { day } = fresh.backfill
  if (day !== state.tape.day) return state
  return {
    ...state,
    tape: {
      ...state.tape,
      offBoard: mergeOffBoard(state.tape.offBoard, fresh.backfill.offBoard),
    },
    candles: foldCandles(fresh.candles, [[...state.tape.trades].reverse()]),
  }
}

/**
 * Asks the relay for one symbol again and applies the answer, unless a later ask began before it
 * came: answers can arrive out of order, and older candles would undo newer ones.
 */
export const symbolRefresh = (
  ask: () => Promise<LiveSymbol>,
  apply: (fresh: LiveSymbol) => void
) => {
  let asks = 0
  return () => {
    const mine = ++asks
    return ask().then((fresh) => {
      if (mine === asks) apply(fresh)
    })
  }
}

export const createLiveSymbolStore = (symbol: Symbol, live: LiveSymbol) => {
  const refresh = symbolRefresh(
    () => liveSymbolQuery({ data: { symbol } }),
    (fresh) => store.update((s) => refold(s, fresh))
  )
  let reconnects = 0
  const store = createRelayStore<LiveSymbolState>({
    symbol,
    initial: liveSymbolState(live),
    reduce: reduceLiveSymbol,
    ticket: () => relayTicket({ data: { symbol } }),
    afterEvent: ({ tape }) => {
      if (tape.socket !== "open" || tape.reconnects === reconnects) return
      reconnects = tape.reconnects
      void refresh()
        // A failure keeps what the page holds, until the next reconnect.
        .catch(() => undefined)
    },
  })
  return store
}

/** The live tape and candles of one symbol, seeded from the loader. */
export const useLiveSymbol = (symbol: Symbol, live: LiveSymbol) => {
  const store = useMemo(
    () => createLiveSymbolStore(symbol, live),
    [symbol, live]
  )
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot
  )
}
