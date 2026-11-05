import { describe, expect, test } from "vitest"

import { IsoDateTime } from "@/domain/time"
import { phaseAt } from "@/relay/calendar"
import type { Calendar, Phase } from "@/relay/calendar"
import { watchdog } from "@/relay/watchdog"
import type { Watchdog } from "@/relay/watchdog"

/** Thursday 2026-10-29, 09:00 WIB. */
const OPEN = Date.parse("2026-10-29T02:00:00Z")
const SEC = 1000

type Turn = {
  readonly at: number
  readonly phase?: Phase
  readonly lastTradeAt?: number
  readonly active?: boolean
}

const turn = (
  state: Watchdog | null,
  { at, phase = "session-1", lastTradeAt, active = true }: Turn
) =>
  watchdog(state, {
    now: OPEN + at * SEC,
    phase,
    lastTradeAt:
      lastTradeAt === undefined
        ? null
        : IsoDateTime.make(new Date(OPEN + lastTradeAt * SEC).toISOString()),
    active,
  })

/** Runs the 30 s alarm from `from` to `to`, keeping only what storage would keep. */
const alarms = (start: Watchdog | null, from: number, to: number) => {
  let state = start
  const sent: Array<{ at: number; step: string }> = []
  for (let at = from; at <= to; at += 30) {
    const next = turn(state, { at })
    state = JSON.parse(JSON.stringify(next.state)) as Watchdog | null
    if (next.send) sent.push({ at, step: next.send })
  }
  return { state, sent }
}

describe("watchdog", () => {
  test("reopens, then reloads, then stops for the rest of the session", () => {
    expect(alarms(null, 0, 3600).sent).toEqual([
      { at: 60, step: "reopen-widget" },
      { at: 120, step: "reload-tab" },
    ])
  })

  test("sends nothing before 60 s into the session", () => {
    expect(alarms(null, 0, 59).sent).toEqual([])
  })

  test("the step survives storage: a restored object takes the next one", () => {
    const { state } = alarms(null, 0, 60)
    expect(alarms(state, 90, 120).sent).toEqual([
      { at: 120, step: "reload-tab" },
    ])
  })

  test("a trade after the reopen means no reload", () => {
    const { state } = alarms(null, 0, 60)
    const after = turn(state, { at: 90, lastTradeAt: 75 })
    expect(after.send).toBeNull()
    expect(turn(after.state, { at: 120, lastTradeAt: 75 }).send).toBeNull()
  })

  test("a trade starts the three steps again, measured from that trade", () => {
    const { state } = alarms(null, 0, 120)
    const quiet = turn(state, { at: 150, lastTradeAt: 140 })
    expect(quiet.send).toBeNull()
    expect(turn(quiet.state, { at: 200, lastTradeAt: 140 }).send).toBe(
      "reopen-widget"
    )
  })

  test("a trade from before the session does not count", () => {
    const first = turn(null, { at: 0, lastTradeAt: -3600 })
    expect(turn(first.state, { at: 60, lastTradeAt: -3600 }).send).toBe(
      "reopen-widget"
    )
  })

  test("the clock waits for an active ingest", () => {
    const none = turn(null, { at: 0, active: false })
    expect(none).toEqual({ state: null, send: null })
    const first = turn(none.state, { at: 300 })
    expect(first.send).toBeNull()
    expect(turn(first.state, { at: 360 }).send).toBe("reopen-widget")
  })

  test("losing the ingest keeps the step and restarts the clock", () => {
    const { state } = alarms(null, 0, 60)
    const gone = turn(state, { at: 90, active: false })
    expect(gone.send).toBeNull()
    expect(turn(gone.state, { at: 120 }).send).toBeNull()
    expect(turn(gone.state, { at: 150 }).send).toBe("reload-tab")
  })

  test("a reload that drops the ingest is still not repeated", () => {
    const { state } = alarms(null, 0, 120)
    const gone = turn(state, { at: 150, active: false })
    expect(alarms(gone.state, 180, 3600).sent).toEqual([])
  })

  test("the next session starts again", () => {
    const { state } = alarms(null, 0, 120)
    const second = turn(state, { at: 16_200, phase: "session-2" })
    expect(second.send).toBeNull()
    expect(turn(second.state, { at: 16_260, phase: "session-2" }).send).toBe(
      "reopen-widget"
    )
  })

  test.each([
    "pre-open",
    "break",
    "closing-auction",
    "post-closing",
    "closed",
  ] as const)("does not run during %s, and forgets its step", (phase) => {
    const { state } = alarms(null, 0, 120)
    expect(turn(state, { at: 3600, phase })).toEqual({
      state: null,
      send: null,
    })
  })

  test("does not run on a listed holiday", () => {
    const calendar: Calendar = {
      holidays: { "2026": ["2026-10-29"] },
      exceptions: {},
    }
    const phase = phaseAt(OPEN + 60 * SEC, calendar)
    expect(turn(null, { at: 0, phase }).state).toBeNull()
    expect(turn(null, { at: 60, phase }).send).toBeNull()
  })

  test("leaves an unchanged state as the same object, so nothing is written", () => {
    const { state } = alarms(null, 0, 120)
    expect(turn(state, { at: 150 }).state).toBe(state)
  })
})
