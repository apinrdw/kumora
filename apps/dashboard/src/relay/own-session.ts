// Holds the own session's socket and timers around the pure machine in
// `upstream.ts`. The socket is outgoing, so it keeps the object awake while open;
// a restart loses it, and the stored machine and pair reconnect. Nothing of the
// credential, or of Stockbit's replies, is ever logged.
import type { Symbol } from "@/domain/symbol"
import type { IsoDateTime } from "@/domain/time"

import { decodeWrap } from "./stockbit"
import type { WrapFrame } from "./stockbit"
import {
  DISABLED,
  UNAUTHORIZED,
  SILENCE_DEAD_MS,
  SILENCE_PING_MS,
  encodeAuth,
  encodeChannel,
  encodePing,
  isUnauthorized,
  parseCredential,
  step,
} from "./upstream"
import type {
  Credential,
  OwnSessionEffect,
  OwnSessionEvent,
  OwnSessionMachine,
} from "./upstream"

/** `DATAFEED_URL` in apps/stockbit-relay-extension/src/protocol.ts is a copy, and names this. */
const STOCKBIT_URL = "https://wss-jkt.trading.stockbit.com/ws"
const MACHINE_KEY = "own-session"
/** A retry nearer than this has its own timer; a later one waits for the alarm. */
const TIMER_LIMIT_MS = 8000

export type StoredCredential = Credential & {
  readonly pushedAt: IsoDateTime
  /** Stockbit answered 401. Kept so the same pair is not pushed and tried again. */
  readonly rejected: boolean
}

export type OwnSessionStore = {
  machine: () => OwnSessionMachine | null
  saveMachine: (machine: OwnSessionMachine) => void
  credential: () => StoredCredential | null
  saveCredential: (credential: StoredCredential) => void
  rejectCredential: () => void
  forgetCredential: () => void
}

export type OwnSessionSocket = {
  send: (bytes: Uint8Array) => void
  close: () => void
  addEventListener: (
    type: "message" | "close" | "error",
    listener: (event: { data: unknown }) => void
  ) => void
}

type Deps = {
  readonly store: OwnSessionStore
  readonly now: () => number
  /** The exchange's hours are open. */
  readonly open: (now: number) => boolean
  readonly symbols: () => ReadonlyArray<Symbol>
  readonly connect: () => Promise<OwnSessionSocket>
  readonly askCredential: () => void
  readonly credentialOk: () => void
  /** The switch went off: no more of the page's frames, until asked again. */
  readonly credentialStop: () => void
  readonly onFrame: (frame: WrapFrame) => void
  /** The state changed, so the source may have. */
  readonly onChange: () => void
  readonly log: (event: string, fields?: Record<string, unknown>) => void
}

/** What `connect` rejects with when the upgrade itself answers 401. */
export const UNAUTHORIZED_UPGRADE = new Error("upgrade answered 401")

export const connectStockbit = async (): Promise<OwnSessionSocket> => {
  const response = await fetch(STOCKBIT_URL, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "web" },
  })
  if (response.status === UNAUTHORIZED) throw UNAUTHORIZED_UPGRADE
  const socket = response.webSocket
  if (!socket) throw new Error("no upgrade")
  socket.accept()
  socket.binaryType = "arraybuffer"
  return socket
}

/** Object state: the switch is the machine leaving `disabled`, the default. */
export const sqlOwnSessionStore = (
  storage: DurableObjectStorage
): OwnSessionStore => {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS own_session_credential (
    id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT NOT NULL, key TEXT NOT NULL,
    token TEXT NOT NULL, expires_at TEXT NOT NULL, pushed_at TEXT NOT NULL,
    rejected INTEGER NOT NULL)`)
  return {
    machine: () => storage.kv.get<OwnSessionMachine>(MACHINE_KEY) ?? null,
    saveMachine: (machine) => storage.kv.put(MACHINE_KEY, machine),
    credential: () => {
      const [row] = storage.sql
        .exec<{
          user_id: string
          key: string
          token: string
          expires_at: IsoDateTime
          pushed_at: IsoDateTime
          rejected: number
        }>("SELECT * FROM own_session_credential")
        .toArray()
      return row
        ? {
            userId: row.user_id,
            key: row.key,
            token: row.token,
            expiresAt: row.expires_at,
            pushedAt: row.pushed_at,
            rejected: row.rejected === 1,
          }
        : null
    },
    saveCredential: (c) => {
      storage.sql.exec(
        "INSERT OR REPLACE INTO own_session_credential VALUES (1, ?, ?, ?, ?, ?, ?)",
        c.userId,
        c.key,
        c.token,
        c.expiresAt,
        c.pushedAt,
        c.rejected ? 1 : 0
      )
    },
    rejectCredential: () => {
      storage.sql.exec("UPDATE own_session_credential SET rejected = 1")
    },
    forgetCredential: () => {
      storage.sql.exec("DELETE FROM own_session_credential")
    },
  }
}

const machineMoved = (a: OwnSessionMachine, b: OwnSessionMachine) =>
  a.state !== b.state || a.tries !== b.tries || a.retryAt !== b.retryAt

export class OwnSession {
  machine: OwnSessionMachine
  private credential: StoredCredential | null
  private socket: OwnSessionSocket | null = null
  /** Bumped per socket, so a late event from an old one does nothing. */
  private generation = 0
  private silence: ReturnType<typeof setTimeout> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private liveprice = ""

  constructor(private readonly deps: Deps) {
    this.machine = deps.store.machine() ?? DISABLED
    this.credential = deps.store.credential()
  }

  /** Once at load. A saved socket state outlived its socket, so it counts as closed. */
  restart() {
    if (this.machine.state === "connecting" || this.machine.state === "live")
      this.dispatch({ type: "closed" })
    else this.armRetry()
  }

  get enabled() {
    return this.machine.state !== "disabled"
  }

  get live() {
    return this.machine.state === "live"
  }

  private get usable(): StoredCredential | null {
    const c = this.credential
    return c && !c.rejected && Date.parse(c.expiresAt) > this.deps.now()
      ? c
      : null
  }

  get needsCredential() {
    return this.enabled && this.usable === null
  }

  get credentialExpiresAt(): IsoDateTime | null {
    return this.usable?.expiresAt ?? null
  }

  setEnabled(enabled: boolean) {
    this.dispatch({ type: enabled ? "switch-on" : "switch-off" })
  }

  tick() {
    this.dispatch({ type: "tick" })
  }

  /** The extension's answer to `credential-needed`. Off, it is not even read. */
  offerCredential(b64: string) {
    if (!this.enabled) return
    const now = this.deps.now()
    if (this.usable) {
      this.deps.credentialOk()
      return
    }
    const pair = parseCredential(b64, now)
    const held = this.credential
    if (!pair || (held?.token === pair.token && held.key === pair.key)) {
      this.deps.log("own-session-credential-refused")
      return
    }
    this.credential = {
      ...pair,
      pushedAt: new Date(now).toISOString() as IsoDateTime,
      rejected: false,
    }
    this.deps.store.saveCredential(this.credential)
    this.deps.log("own-session-credential-stored", {
      expiresAt: pair.expiresAt,
    })
    this.deps.credentialOk()
    this.dispatch({ type: "credential" })
  }

  /** Whole-state on Stockbit's side, so a change re-sends the channel frame. */
  setLiveprice(symbols: ReadonlyArray<Symbol>) {
    const list = symbols.join(",")
    const pair = this.usable
    if (!this.socket || !pair || list === this.liveprice) return
    this.liveprice = list
    this.socket.send(encodeChannel(pair, symbols))
  }

  private dispatch(event: OwnSessionEvent) {
    const from = this.machine
    const now = this.deps.now()
    const { machine, effects } = step(from, event, {
      now,
      open: this.deps.open(now),
      credential: this.usable !== null,
    })
    this.machine = machine
    if (machineMoved(from, machine)) this.deps.store.saveMachine(machine)
    for (const effect of effects) this.effects[effect]()
    this.armRetry()
    if (machine.state === from.state) return
    this.deps.log("own-session-state", {
      from: from.state,
      to: machine.state,
      tries: machine.tries,
    })
    this.deps.onChange()
  }

  private readonly effects: Record<OwnSessionEffect, () => void> = {
    connect: () => void this.open(),
    disconnect: () => this.disconnect(),
    "ask-credential": () => this.deps.askCredential(),
    "reject-credential": () => {
      this.deps.store.rejectCredential()
      if (this.credential)
        this.credential = { ...this.credential, rejected: true }
    },
    "forget-credential": () => {
      this.deps.store.forgetCredential()
      this.credential = null
      this.deps.credentialStop()
    },
  }

  private armRetry() {
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    if (this.machine.state !== "backoff") return
    const wait = this.machine.retryAt - this.deps.now()
    if (wait <= TIMER_LIMIT_MS)
      this.retry = setTimeout(() => this.tick(), Math.max(wait, 0))
  }

  private async open() {
    const generation = ++this.generation
    this.armSilence(generation)
    let socket: OwnSessionSocket
    try {
      socket = await this.deps.connect()
    } catch (error) {
      if (generation !== this.generation) return
      this.dropSocket()
      this.deps.log("own-session-connect-failed", {
        unauthorized: error === UNAUTHORIZED_UPGRADE,
      })
      this.dispatch({
        type: error === UNAUTHORIZED_UPGRADE ? "unauthorized" : "closed",
      })
      return
    }
    if (generation !== this.generation) {
      socket.close()
      return
    }
    this.socket = socket
    const lost = () => {
      if (generation !== this.generation) return
      this.dropSocket()
      this.dispatch({ type: "closed" })
    }
    socket.addEventListener("close", lost)
    socket.addEventListener("error", lost)
    socket.addEventListener("message", ({ data }) => {
      if (generation !== this.generation || !(data instanceof ArrayBuffer))
        return
      this.received(generation, new Uint8Array(data))
    })
    const pair = this.usable
    if (!pair) return
    const symbols = this.deps.symbols()
    this.liveprice = symbols.join(",")
    socket.send(encodeAuth(pair))
    socket.send(encodeChannel(pair, symbols))
  }

  private received(generation: number, bytes: Uint8Array) {
    if (isUnauthorized(bytes)) {
      this.dispatch({ type: "unauthorized" })
      return
    }
    const frame = decodeWrap(bytes)
    if (
      frame.channel === "running_trade_batch" ||
      frame.channel === "liveprice"
    ) {
      this.armSilence(generation)
      this.dispatch({ type: "frame" })
    } else if (frame.channel === "ping" && this.live) {
      // The tape is dead through the break, and that is no reason to reconnect.
      this.armSilence(generation)
    }
    this.deps.onFrame(frame)
  }

  /** Ping after 15 s without a data frame; dead 13 s later. Connecting counts too. */
  private armSilence(generation: number) {
    if (this.silence) clearTimeout(this.silence)
    this.silence = setTimeout(() => {
      if (generation !== this.generation) return
      this.socket?.send(encodePing())
      this.silence = setTimeout(() => {
        if (generation === this.generation) this.dispatch({ type: "silence" })
      }, SILENCE_DEAD_MS)
    }, SILENCE_PING_MS)
  }

  private dropSocket() {
    this.generation++
    this.socket = null
    if (this.silence) clearTimeout(this.silence)
    this.silence = null
  }

  private disconnect() {
    const socket = this.socket
    this.dropSocket()
    socket?.close()
  }
}
