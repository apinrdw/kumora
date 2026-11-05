// The relay's own Stockbit session: its state machine and frame encoders, pure.
// `own-session.ts` holds the socket and the timers. The object never logs in
// and never refreshes: it runs on the pair the extension pushes, and treats a 401
// or an expired token as the own session going down.
// WebsocketRequest: 1 user_id, 2 channel, 3 key, 4 ping, 5 access_token.
// WebsocketChannel: 5 running_trade_batch, 6 liveprice.
// WebsocketWrapMessageChannel: 7 error { 1 code }.
import type { Symbol } from "@/domain/symbol"
import type { IsoDateTime } from "@/domain/time"
import type { OwnSessionState } from "@/domain/trade"

import { fields } from "./stockbit"

const BACKOFF_MS = [1000, 2000, 4000, 8000]
/** After four tries, a retry waits for this alarm. */
export const BACKOFF_ALARM_MS = 300_000
/** Ping after this much silence, on Stockbit's own client's timing. */
export const SILENCE_PING_MS = 15_000
/** Dead this long after the ping: 28 s in all. */
export const SILENCE_DEAD_MS = 13_000
export const UNAUTHORIZED = 401

export type OwnSessionMachine = {
  readonly state: OwnSessionState
  /** Failed connects since the last tape or `liveprice` frame. */
  readonly tries: number
  /** While `backoff`: when to connect again. */
  readonly retryAt: number
}

export const DISABLED: OwnSessionMachine = {
  state: "disabled",
  tries: 0,
  retryAt: 0,
}

export type OwnSessionContext = {
  readonly now: number
  /** The exchange's hours are open. */
  readonly open: boolean
  /** A pair is stored, unexpired and not refused by Stockbit. */
  readonly credential: boolean
}

export type OwnSessionEvent = {
  readonly type:
    | "switch-on"
    | "switch-off"
    | "tick"
    | "credential"
    | "frame"
    | "closed"
    | "silence"
    | "unauthorized"
}

export type OwnSessionEffect =
  | "connect"
  | "disconnect"
  | "ask-credential"
  | "reject-credential"
  | "forget-credential"

type Step = {
  readonly machine: OwnSessionMachine
  readonly effects: ReadonlyArray<OwnSessionEffect>
}

const at = (state: OwnSessionState): OwnSessionMachine => ({
  state,
  tries: 0,
  retryAt: 0,
})

const hasSocket = ({ state }: OwnSessionMachine) =>
  state === "connecting" || state === "live"

/** Where the hours and the credential put a session that may connect. */
const settle = (m: OwnSessionMachine, ctx: OwnSessionContext): Step => {
  const leaving: ReadonlyArray<OwnSessionEffect> = hasSocket(m)
    ? ["disconnect"]
    : []
  if (!ctx.open) return { machine: at("idle"), effects: leaving }
  if (!ctx.credential)
    return {
      machine: at("no-credential"),
      effects: [...leaving, "ask-credential"],
    }
  return { machine: { ...m, state: "connecting" }, effects: ["connect"] }
}

const backoff = (
  m: OwnSessionMachine,
  ctx: OwnSessionContext
): OwnSessionMachine => ({
  state: "backoff",
  tries: m.tries + 1,
  retryAt: ctx.now + (BACKOFF_MS[m.tries] ?? BACKOFF_ALARM_MS),
})

const stay = (m: OwnSessionMachine): Step => ({ machine: m, effects: [] })

const switchedOff = (m: OwnSessionMachine): Step => ({
  machine: DISABLED,
  effects: [
    ...(hasSocket(m) ? (["disconnect"] as const) : []),
    "forget-credential",
  ],
})

/** `connecting` and `live`: the socket's own events decide. */
const stepWithSocket = (
  m: OwnSessionMachine,
  type: OwnSessionEvent["type"],
  ctx: OwnSessionContext
): Step => {
  switch (type) {
    case "frame":
      return { machine: at("live"), effects: [] }
    case "closed":
      return { machine: backoff(m, ctx), effects: [] }
    case "silence":
      return { machine: backoff(m, ctx), effects: ["disconnect"] }
    case "unauthorized":
      return {
        machine: at("no-credential"),
        effects: ["disconnect", "reject-credential", "ask-credential"],
      }
    case "tick":
      return ctx.open && ctx.credential ? stay(m) : settle(m, ctx)
    default:
      return stay(m)
  }
}

/** `idle`, `no-credential` and `backoff`, on a tick or a pushed credential. */
const stepWithoutSocket = (
  m: OwnSessionMachine,
  ctx: OwnSessionContext
): Step => {
  if (m.state === "idle") return ctx.open ? settle(m, ctx) : stay(m)
  if (!ctx.open || !ctx.credential) {
    const next = settle(m, ctx)
    return next.machine.state === m.state ? stay(m) : next
  }
  return m.state === "backoff" && ctx.now < m.retryAt ? stay(m) : settle(m, ctx)
}

export const step = (
  m: OwnSessionMachine,
  { type }: OwnSessionEvent,
  ctx: OwnSessionContext
): Step => {
  if (m.state === "disabled")
    return type === "switch-on" ? settle(m, ctx) : stay(m)
  if (type === "switch-off") return switchedOff(m)
  if (hasSocket(m)) return stepWithSocket(m, type, ctx)
  return type === "tick" || type === "credential"
    ? stepWithoutSocket(m, ctx)
    : stay(m)
}

/** When the object's alarm must fire for the session. Null needs none. */
export const wakeAt = (
  m: OwnSessionMachine,
  now: number,
  nextOpen: (now: number) => number
): number | null => {
  if (m.state === "disabled") return null
  if (m.state === "idle") return nextOpen(now)
  const alarm = now + BACKOFF_ALARM_MS
  return m.state === "backoff" ? Math.min(m.retryAt, alarm) : alarm
}

// ── the credential ──────────────────────────────────────────────────────

export type Credential = {
  readonly userId: string
  readonly key: string
  readonly token: string
  readonly expiresAt: IsoDateTime
}

const utf8 = new TextDecoder()

const tokenExpiry = (token: string): number | null => {
  const payload = token.split(".")[1]
  if (!payload) return null
  const parsed = JSON.parse(
    atob(payload.replaceAll("-", "+").replaceAll("_", "/"))
  ) as { exp?: unknown }
  return typeof parsed.exp === "number" ? parsed.exp * 1000 : null
}

/**
 * Reads the page's auth frame, sent as base64. Null when it is not one, or its
 * token has expired. It reports no reason, so nothing of the frame reaches a log.
 */
export const parseCredential = (
  b64: string,
  now: number
): Credential | null => {
  try {
    const frame = fields(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
    const read = (no: number) => {
      const field = frame.find((f) => f.no === no && f.wire === 2)
      return field ? utf8.decode(field.bytes) : ""
    }
    const [userId, key, token] = [read(1), read(3), read(5)]
    const expiry = tokenExpiry(token)
    if (!userId || !key || expiry === null || expiry <= now) return null
    return {
      userId,
      key,
      token,
      expiresAt: new Date(expiry).toISOString() as IsoDateTime,
    }
  } catch {
    return null
  }
}

// ── the frames ──────────────────────────────────────────────────────────

export const varint = (value: number): Array<number> => {
  const out: Array<number> = []
  let rest = value
  while (rest >= 128) {
    out.push((rest % 128) | 0x80)
    rest = Math.floor(rest / 128)
  }
  out.push(rest)
  return out
}

const utf8Encoder = new TextEncoder()

const message = (no: number, body: ArrayLike<number>): Array<number> => [
  ...varint(no * 8 + 2),
  ...varint(body.length),
  ...Array.from(body),
]

const string = (no: number, text: string) =>
  message(no, utf8Encoder.encode(text))

type Pair = Pick<Credential, "userId" | "key" | "token">

export const encodeAuth = ({ userId, key, token }: Pair): Uint8Array =>
  new Uint8Array([...string(1, userId), ...string(3, key), ...string(5, token)])

/** Whole market, set once, plus the wall coverage. Subscribing is whole-state. */
export const encodeChannel = (
  { userId, key, token }: Pair,
  symbols: ReadonlyArray<Symbol>
): Uint8Array =>
  new Uint8Array([
    ...string(1, userId),
    ...message(2, [
      ...string(5, "*"),
      ...symbols.flatMap((symbol) => string(6, symbol)),
    ]),
    ...string(3, key),
    ...string(5, token),
  ])

export const encodePing = (): Uint8Array =>
  new Uint8Array(message(4, string(1, "ping")))

/** An `error` frame with code 401. */
export const isUnauthorized = (frame: Uint8Array): boolean => {
  try {
    const error = fields(frame).find((f) => f.no === 7)
    return (
      error !== undefined &&
      fields(error.bytes).some((f) => f.no === 1 && f.int === UNAUTHORIZED)
    )
  } catch {
    return false
  }
}

/** The body of `POST /api/relay/upstream`. Null for anything but a boolean. */
export const parseSwitch = (body: string): boolean | null => {
  try {
    const parsed = JSON.parse(body) as { enabled?: unknown } | null
    return typeof parsed?.enabled === "boolean" ? parsed.enabled : null
  } catch {
    return null
  }
}
