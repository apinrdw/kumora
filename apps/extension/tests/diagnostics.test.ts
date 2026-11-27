import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Option } from "effect"

import { diagnosticsText } from "../src/options/diagnostics-text.ts"
import type { StallRecord } from "../src/worker/broker-codes/stall-records.ts"
import { stallRecordStore } from "../src/worker/settings.ts"
import { memorySession } from "./memory-session.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

const DAY = WibDate.make("2026-11-27")
const at = (time: string) => Date.parse(`2026-11-27T${time}+07:00`)
const NONE = { "refused-token": 0, "no-answer": 0, timeout: 0 }

// The tape walk's second pass stalled on its 7th page for 2.5 minutes.
const TAPE: StallRecord = {
  began: at("17:06:11"),
  ended: null,
  walk: "tape",
  day: DAY,
  pass: "second",
  page: 7,
  pages: 23,
  kind: "timeout",
  failures: 1,
  tokenChanged: false,
  kinds: { ...NONE, timeout: 1 },
  reloads: 0,
}

const textOf = (stalls: ReadonlyArray<StallRecord>) =>
  diagnosticsText({
    version: "0.0.58",
    stopped: Option.none(),
    errors: [],
    keys: [],
    stalls,
  })

describe("Copy diagnostics' stall records", () => {
  it.effect(
    "lists each kept stall on a line: when, the walk and where, and why",
    () =>
      Effect.gen(function* () {
        memorySession()
        yield* stallRecordStore.record(TAPE)
        // The same stall again, ended: it replaces its open write.
        yield* stallRecordStore.record({
          ...TAPE,
          ended: at("17:08:46"),
          kind: "refused-token",
          failures: 9,
          tokenChanged: true,
          kinds: { ...NONE, timeout: 8, "refused-token": 1 },
          reloads: 2,
        })
        // A Done Details stall the worker never ended.
        yield* stallRecordStore.record({
          began: at("17:12:00"),
          ended: null,
          walk: "done-details",
          day: DAY,
          code: StockCode.make("BBCA"),
          page: 3,
          kind: "no-answer",
          failures: 1,
          tokenChanged: false,
          kinds: { ...NONE, "no-answer": 1 },
          reloads: 0,
        })
        const text = yield* textOf(yield* stallRecordStore.load)
        assert.include(
          text,
          [
            "Stall records (2):",
            "2026-11-27T10:06:11.000Z to 2026-11-27T10:08:46.000Z | tape 2026-11-27 second pass page 7 of 23 | last refused-token, 9 failed in a row (refused-token 1, timeout 8), token changed, 2 reloads",
            "2026-11-27T10:12:00.000Z to open | done-details 2026-11-27 BBCA page 3 | last no-answer, 1 failed in a row (no-answer 1), token unchanged, 0 reloads",
          ].join("\n")
        )
      })
  )

  it.effect("keeps the last 50 stalls, dropping the oldest", () =>
    Effect.gen(function* () {
      memorySession()
      for (let each = 0; each < 51; each++)
        yield* stallRecordStore.record({
          ...TAPE,
          began: TAPE.began + each * 60_000,
        })
      const kept = yield* stallRecordStore.load
      assert.lengthOf(kept, 50)
      assert.strictEqual(kept[0]?.began, TAPE.began + 60_000)
      assert.include(yield* textOf(kept), "Stall records (50):")
    })
  )

  it.effect("says none while no stall is kept", () =>
    Effect.gen(function* () {
      memorySession()
      assert.include(
        yield* textOf(yield* stallRecordStore.load),
        "Stall records (0):"
      )
    })
  )
})
