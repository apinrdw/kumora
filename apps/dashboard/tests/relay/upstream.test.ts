import { Symbol } from "@/domain/symbol"
import { describe, expect, test } from "vitest"

import {
  BACKOFF_ALARM_MS,
  DISABLED,
  encodeAuth,
  encodeChannel,
  encodePing,
  isUnauthorized,
  parseCredential,
  parseSwitch,
  step,
  wakeAt,
} from "@/relay/upstream"
import type { OwnSessionContext, OwnSessionMachine } from "@/relay/upstream"

const NOW = Date.parse("2026-10-29T03:00:00Z")
const HOURS: OwnSessionContext = { now: NOW, open: true, credential: true }
const NO_PAIR: OwnSessionContext = { ...HOURS, credential: false }
const SHUT: OwnSessionContext = { ...HOURS, open: false }

const machine = (
  state: OwnSessionMachine["state"],
  tries = 0,
  retryAt = 0
): OwnSessionMachine => ({ state, tries, retryAt })

const b64url = (text: string) =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
const jwt = (exp: number) =>
  `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ exp }))}.signature`

const str = (no: number, text: string) => {
  const bytes = new TextEncoder().encode(text)
  return [no * 8 + 2, bytes.length, ...bytes]
}
/** `user_id` 1, `key` 3, `access_token` 5. */
const authFrame = (token: string) =>
  btoa(
    String.fromCharCode(...str(1, "42"), ...str(3, "key-1"), ...str(5, token))
  )
const FUTURE = Math.floor(NOW / 1000) + 3600

describe("the state table", () => {
  test("a new object is disabled", () => {
    expect(DISABLED.state).toBe("disabled")
  })

  test("disabled stays disabled until the switch", () => {
    for (const event of ["tick", "credential", "frame", "closed"] as const)
      expect(step(DISABLED, { type: event }, HOURS).machine.state).toBe(
        "disabled"
      )
  })

  test("disabled, switch on: where it lands depends on hours and credential", () => {
    const on = { type: "switch-on" } as const
    expect(step(DISABLED, on, SHUT).machine.state).toBe("idle")
    expect(step(DISABLED, on, NO_PAIR)).toEqual({
      machine: machine("no-credential"),
      effects: ["ask-credential"],
    })
    expect(step(DISABLED, on, HOURS)).toEqual({
      machine: machine("connecting"),
      effects: ["connect"],
    })
  })

  test("idle leaves on the next-open alarm, not before", () => {
    const tick = { type: "tick" } as const
    expect(step(machine("idle"), tick, SHUT).machine.state).toBe("idle")
    expect(step(machine("idle"), tick, HOURS).machine.state).toBe("connecting")
    expect(step(machine("idle"), tick, NO_PAIR).effects).toEqual([
      "ask-credential",
    ])
  })

  test("no-credential leaves when a credential is pushed", () => {
    const before = machine("no-credential")
    expect(step(before, { type: "tick" }, NO_PAIR)).toEqual({
      machine: before,
      effects: [],
    })
    expect(step(before, { type: "credential" }, HOURS)).toEqual({
      machine: machine("connecting"),
      effects: ["connect"],
    })
  })

  test("no-credential goes idle at the close", () => {
    expect(
      step(
        machine("no-credential"),
        { type: "tick" },
        { ...NO_PAIR, open: false }
      ).machine.state
    ).toBe("idle")
  })

  test("connecting: the first frame is live, and clears the tries", () => {
    expect(step(machine("connecting", 3), { type: "frame" }, HOURS)).toEqual({
      machine: machine("live"),
      effects: [],
    })
  })

  test("connecting: a close backs off", () => {
    expect(
      step(machine("connecting"), { type: "closed" }, HOURS).machine
    ).toEqual(machine("backoff", 1, NOW + 1000))
  })

  test("connecting: a 401 drops the pair and asks again", () => {
    expect(
      step(machine("connecting"), { type: "unauthorized" }, HOURS)
    ).toEqual({
      machine: machine("no-credential"),
      effects: ["disconnect", "reject-credential", "ask-credential"],
    })
  })

  test("live: silence backs off", () => {
    expect(step(machine("live"), { type: "silence" }, HOURS)).toEqual({
      machine: machine("backoff", 1, NOW + 1000),
      effects: ["disconnect"],
    })
  })

  test("live: a 401 takes the own session down, not an error", () => {
    expect(
      step(machine("live"), { type: "unauthorized" }, HOURS).machine.state
    ).toBe("no-credential")
  })

  test("live: the close of trade is idle", () => {
    expect(step(machine("live"), { type: "tick" }, SHUT)).toEqual({
      machine: machine("idle"),
      effects: ["disconnect"],
    })
  })

  test("live: an expired credential takes the own session down", () => {
    expect(step(machine("live"), { type: "tick" }, NO_PAIR)).toEqual({
      machine: machine("no-credential"),
      effects: ["disconnect", "ask-credential"],
    })
  })

  test("backoff: the timer connects, once its time has come", () => {
    const waiting = machine("backoff", 1, NOW + 1000)
    expect(step(waiting, { type: "tick" }, HOURS).machine).toEqual(waiting)
    expect(
      step(waiting, { type: "tick" }, { ...HOURS, now: NOW + 1000 })
    ).toEqual({
      machine: { ...waiting, state: "connecting" },
      effects: ["connect"],
    })
  })

  test("backoff: an expired credential or the close wins over the retry", () => {
    const due = machine("backoff", 1, NOW)
    expect(step(due, { type: "tick" }, NO_PAIR).machine.state).toBe(
      "no-credential"
    )
    expect(step(due, { type: "tick" }, SHUT).machine.state).toBe("idle")
  })

  test("the switch going off forgets the pair from every state", () => {
    for (const state of [
      "idle",
      "no-credential",
      "connecting",
      "live",
      "backoff",
    ] as const) {
      const { machine: next, effects } = step(
        machine(state),
        { type: "switch-off" },
        HOURS
      )
      expect(next).toEqual(DISABLED)
      expect(effects).toContain("forget-credential")
      expect(effects.includes("disconnect")).toBe(
        state === "connecting" || state === "live"
      )
    }
  })
})

describe("the backoff", () => {
  test("waits 1, 2, 4, 8 s, then for the alarm", () => {
    let m = machine("connecting")
    const waits: Array<number> = []
    for (let i = 0; i < 6; i++) {
      m = step(m, { type: "closed" }, HOURS).machine
      waits.push(m.retryAt - NOW)
      m = { ...m, state: "connecting" }
    }
    expect(waits).toEqual([
      1000,
      2000,
      4000,
      8000,
      BACKOFF_ALARM_MS,
      BACKOFF_ALARM_MS,
    ])
  })

  test("a frame starts the count again", () => {
    const live = step(
      machine("connecting", 4),
      { type: "frame" },
      HOURS
    ).machine
    expect(step(live, { type: "closed" }, HOURS).machine.retryAt).toBe(
      NOW + 1000
    )
  })
})

describe("wakeAt", () => {
  test("disabled needs no alarm", () => {
    expect(wakeAt(DISABLED, NOW, () => NOW + 5)).toBeNull()
  })

  test("idle needs one alarm, for the next open", () => {
    expect(wakeAt(machine("idle"), NOW, () => NOW + 5)).toBe(NOW + 5)
  })

  test("any other state wakes within 5 minutes, or sooner for a retry", () => {
    expect(wakeAt(machine("live"), NOW, () => 0)).toBe(NOW + 300_000)
    expect(wakeAt(machine("backoff", 1, NOW + 1000), NOW, () => 0)).toBe(
      NOW + 1000
    )
  })
})

describe("parseCredential", () => {
  test("reads the page's auth frame, with the expiry from the token", () => {
    const token = jwt(FUTURE)
    expect(parseCredential(authFrame(token), NOW)).toEqual({
      userId: "42",
      key: "key-1",
      token,
      expiresAt: new Date(FUTURE * 1000).toISOString(),
    })
  })

  test("refuses an expired token", () => {
    expect(
      parseCredential(authFrame(jwt(Math.floor(NOW / 1000) - 1)), NOW)
    ).toBeNull()
  })

  test("refuses what is not an auth frame", () => {
    expect(parseCredential("not base64 !", NOW)).toBeNull()
    expect(parseCredential(btoa("\x00\x01"), NOW)).toBeNull()
    expect(parseCredential(authFrame("not-a-jwt"), NOW)).toBeNull()
    expect(
      parseCredential(btoa(String.fromCharCode(...str(5, jwt(FUTURE)))), NOW)
    ).toBeNull()
  })
})

describe("the frames", () => {
  const pair = { userId: "42", key: "key-1", token: "t" }
  const bytes = (values: ReadonlyArray<number>) => new Uint8Array(values)

  test("auth holds user id, key and token, and no channel", () => {
    expect(encodeAuth(pair)).toEqual(
      bytes([...str(1, "42"), ...str(3, "key-1"), ...str(5, "t")])
    )
  })

  test("the channel asks for the whole market, plus the liveprice list", () => {
    const channel = [...str(5, "*"), ...str(6, "BBCA")]
    expect(encodeChannel(pair, [Symbol.make("BBCA")])).toEqual(
      bytes([
        ...str(1, "42"),
        2 * 8 + 2,
        channel.length,
        ...channel,
        ...str(3, "key-1"),
        ...str(5, "t"),
      ])
    )
  })

  test("the ping is the page's own, from the capture", () => {
    expect(btoa(String.fromCharCode(...encodePing()))).toBe("IgYKBHBpbmc=")
  })

  test("isUnauthorized reads an `error` frame with code 401", () => {
    expect(isUnauthorized(bytes([7 * 8 + 2, 3, 0x08, 0x91, 0x03]))).toBe(true)
    expect(isUnauthorized(bytes([7 * 8 + 2, 3, 0x08, 0x90, 0x03]))).toBe(false)
    expect(isUnauthorized(bytes([0x12, 0x00]))).toBe(false)
    expect(isUnauthorized(bytes([0xff]))).toBe(false)
  })
})

describe("parseSwitch", () => {
  test("takes only a boolean `enabled`", () => {
    expect(parseSwitch('{"enabled":true}')).toBe(true)
    expect(parseSwitch('{"enabled":false}')).toBe(false)
    expect(parseSwitch('{"enabled":"yes"}')).toBeNull()
    expect(parseSwitch("{")).toBeNull()
    expect(parseSwitch("null")).toBeNull()
  })
})
