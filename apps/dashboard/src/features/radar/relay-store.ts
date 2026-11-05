// One WebSocket to the relay per page view, folded by whatever reducer the page
// brings. No `effect` here, and the domain only as types.
import type { TradeFrame } from "@/domain/trade"
import { PING, PONG, TRADES_PATH, TRADES_QUERY } from "@/relay/routes"
import type { TicketSubject } from "@/relay/routes"

const PING_MS = 15_000
const SILENT_MS = 30_000
const FIRST_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000

export type RelaySocket = "idle" | "connecting" | "open" | "closed"

export type RelayEvent =
  | { type: "frame"; frame: TradeFrame }
  | { type: "socket"; socket: RelaySocket }
  | { type: "silent" }

/** What the store does about a socket it has not heard from. */
export type SilenceAction = "none" | "demote" | "reconnect"

/**
 * The browser cannot promote, and the relay pushes only a changed status, so a
 * demotion needs a new socket: the relay sends every opening socket its status.
 */
export const silenceAction = (
  silentMs: number,
  hasSocket: boolean
): SilenceAction => {
  if (silentMs <= SILENT_MS) return "none"
  return hasSocket ? "reconnect" : "demote"
}

/** `S.seq` is the resume point of a new socket. */
export const createRelayStore = <S extends { readonly seq: number }>({
  symbol,
  initial,
  reduce,
  ticket: fetchTicket,
  afterEvent,
}: {
  /** The `symbol` of the upgrade. */
  readonly symbol: TicketSubject
  /** Also the server snapshot, which must stay the same object or React loops. */
  readonly initial: S
  readonly reduce: (state: S, event: RelayEvent) => S
  readonly ticket: () => Promise<string>
  /** What the page does about the state an event left, outside the pure reducer. */
  readonly afterEvent?: (state: S) => void
}) => {
  let state = initial
  const listeners = new Set<() => void>()
  const dispatch = (event: RelayEvent) => {
    state = reduce(state, event)
    for (const l of listeners) l()
    afterEvent?.(state)
  }

  let ws: WebSocket | null = null
  /** Bumped by start and stop, so an attempt outlived by either gives up. */
  let run = 0
  let backoff = FIRST_BACKOFF_MS
  let lastHeard = Date.now()
  let timer: ReturnType<typeof setInterval> | undefined
  let retry: ReturnType<typeof setTimeout> | undefined

  const retryLater = (from: number) => {
    if (from !== run) return
    retry = setTimeout(() => void connect(from), backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
  }

  const connect = async (from: number) => {
    dispatch({ type: "socket", socket: "connecting" })
    // The ticket fetch fails too while the Worker restarts (a deploy); it retries like the socket.
    const ticket = await fetchTicket().catch(() => null)
    if (from !== run) return
    if (ticket === null) {
      dispatch({ type: "socket", socket: "closed" })
      retryLater(from)
      return
    }
    const proto = location.protocol === "https:" ? "wss" : "ws"
    const q = new URLSearchParams({
      [TRADES_QUERY.symbol]: symbol,
      [TRADES_QUERY.since]: String(state.seq),
      [TRADES_QUERY.ticket]: ticket,
    })
    const socket = new WebSocket(
      `${proto}://${location.host}${TRADES_PATH}?${q}`
    )
    ws = socket
    lastHeard = Date.now()
    socket.onopen = () => {
      backoff = FIRST_BACKOFF_MS
      lastHeard = Date.now()
      dispatch({ type: "socket", socket: "open" })
    }
    socket.onmessage = (e: MessageEvent<string>) => {
      lastHeard = Date.now()
      if (e.data === PONG) return
      dispatch({ type: "frame", frame: JSON.parse(e.data) as TradeFrame })
    }
    socket.onclose = () => {
      if (ws !== socket) return
      ws = null
      dispatch({ type: "socket", socket: "closed" })
      retryLater(from)
    }
  }

  /** A dead socket's close handshake can hang, so its replacement does not wait for it. */
  const replaceSocket = () => {
    const dead = ws
    if (dead === null) return
    ws = null
    dead.onmessage = null
    dead.close()
    dispatch({ type: "socket", socket: "closed" })
    retryLater(run)
  }

  const tick = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(PING)
    const action = silenceAction(Date.now() - lastHeard, ws !== null)
    if (action === "demote") dispatch({ type: "silent" })
    if (action === "reconnect") replaceSocket()
  }

  const start = () => {
    lastHeard = Date.now()
    void connect(++run)
    timer = setInterval(tick, PING_MS)
  }
  const stop = () => {
    run++
    clearInterval(timer)
    clearTimeout(retry)
    ws?.close()
    ws = null
  }

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    /** A change that did not come over the socket, such as a page loaded by hand. */
    update: (change: (state: S) => S) => {
      state = change(state)
      for (const l of listeners) l()
    },
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
  }
}
