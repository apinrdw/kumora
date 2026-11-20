import { assert, describe, it } from "@effect/vitest"
import {
  BrokerCodesProtocolVersion,
  TradeNumber,
  WibDate,
  type BrokerCodesStatus,
} from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"

import {
  dayView,
  historyView,
  walkView,
} from "../src/options/broker-codes-view.ts"
import { recentClosedDays } from "../src/worker/broker-codes/hours.ts"
import type { WalkPhase } from "../src/worker/broker-codes/run-queue.ts"

const DAY = WibDate.make("2026-11-12")
const COMPLETE: BrokerCodesStatus = {
  version: BrokerCodesProtocolVersion,
  day: DAY,
  n: TradeNumber.make("1000"),
  complete: true,
  missing: [],
  missingCount: 0,
  sources: { ajaib: 990, stockbit: 10 },
  crossCheck: { state: "compared", covered: 1000, differences: 0 },
}
const at = (wib: string) => DateTime.makeUnsafe(`${wib}+07:00`)

describe("the options page's broker codes section", () => {
  it.effect("lists the last 10 closed trading days, newest first", () =>
    Effect.gen(function* () {
      // 2026-11-12 16:00, before its close: from 2026-11-11 back.
      const before = yield* recentClosedDays(at("2026-11-12T16:00:00"), 10)
      assert.strictEqual(before[0], "2026-11-11")
      assert.lengthOf(before, 10)
      assert.notInclude(before, WibDate.make("2026-11-08"))
      const after = yield* recentClosedDays(at("2026-11-12T16:35:00"), 10)
      assert.strictEqual(after[0], "2026-11-12")
    })
  )

  it.effect("shows a day's completeness, sites and cross-check", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* dayView(Option.some(COMPLETE), Option.none()),
        {
          held: "Complete",
          missing: [],
          more: 0,
          sites: "Ajaib and Stockbit",
          crossCheck: "matches",
          behind: false,
        }
      )
      const partial: BrokerCodesStatus = {
        ...COMPLETE,
        complete: false,
        missing: [
          [TradeNumber.make("5"), TradeNumber.make("9")],
          [TradeNumber.make("262370"), TradeNumber.make("262370")],
        ],
        missingCount: 6,
        sources: { ajaib: 0, stockbit: 994 },
        crossCheck: { state: "none" },
      }
      assert.deepStrictEqual(
        yield* dayView(Option.some(partial), Option.none()),
        {
          held: "6 missing",
          missing: ["5–9", "262,370"],
          more: 0,
          sites: "Stockbit",
          crossCheck: "no cross-check",
          behind: false,
        }
      )
      // A list cut short at MISSING_RANGES shows the day's whole count.
      assert.include(
        yield* dayView(
          Option.some({ ...partial, missingCount: 750_000 }),
          Option.none()
        ),
        { held: "750,000 missing", more: 749_994 }
      )
      const checking: BrokerCodesStatus = {
        ...COMPLETE,
        sources: { ajaib: 1000, stockbit: 0 },
        crossCheck: { state: "pending", walkedTo: TradeNumber.make("400") },
      }
      assert.include(yield* dayView(Option.some(checking), Option.none()), {
        sites: "Ajaib",
        crossCheck: "checking",
      })
      const differs: BrokerCodesStatus = {
        ...COMPLETE,
        crossCheck: { state: "compared", covered: 1000, differences: 3 },
      }
      assert.include(yield* dayView(Option.some(differs), Option.none()), {
        crossCheck: "3 differences",
      })
      assert.deepStrictEqual(yield* dayView(Option.none(), Option.none()), {
        held: "Unknown",
        missing: [],
        more: 0,
        sites: "",
        crossCheck: "",
        behind: false,
      })
    })
  )

  it.effect("marks a day the extra target holds less of", () =>
    Effect.gen(function* () {
      const less: BrokerCodesStatus = {
        ...COMPLETE,
        complete: false,
        missing: [[TradeNumber.make("1"), TradeNumber.make("10")]],
        missingCount: 10,
        sources: { ajaib: 990, stockbit: 0 },
      }
      assert.isTrue(
        (yield* dayView(Option.some(COMPLETE), Option.some(less))).behind
      )
      assert.isFalse(
        (yield* dayView(Option.some(COMPLETE), Option.some(COMPLETE))).behind
      )
      // Lacking what Production lacks is not behind.
      assert.isFalse(
        (yield* dayView(Option.some(less), Option.some(less))).behind
      )
    })
  )

  it.effect("shows the walk's trades of N, pace and time left", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* walkView({
          state: "walking",
          walk: "newest",
          day: DAY,
          feed: "Stockbit",
          trades: { fetched: 460_000, of: 1_000_000, perSecond: 300 },
        }),
        {
          walk: "Stockbit, 2026-11-12 (newest closed day)",
          phase: "",
          trades: "460,000 of 1,000,000 trades",
          repair: "",
          pace: "300 trades/s",
          left: "30 min left",
        }
      )
      assert.deepStrictEqual(
        yield* walkView({
          state: "walking",
          walk: "history",
          day: DAY,
          feed: "Stockbit",
        }),
        {
          walk: "Stockbit, 2026-11-12 (History)",
          phase: "",
          trades: "",
          repair: "",
          pace: "",
          left: "",
        }
      )
    })
  )

  it.effect(
    "shows the repair pass's blocks and its own time left, not the first pass's",
    () =>
      Effect.gen(function* () {
        const walking = {
          state: "walking",
          walk: "newest",
          day: DAY,
          feed: "Ajaib",
        } as const
        const trades = { fetched: 1_597_070, of: 1_597_351, perSecond: 1_040 }
        // The pass has just started: no block walked again yet, so no pace.
        assert.deepStrictEqual(
          yield* walkView({
            ...walking,
            trades,
            repair: { done: 0, of: 87, perSecond: null },
          }),
          {
            walk: "Ajaib, 2026-11-12 (newest closed day)",
            phase: "",
            trades: "1,597,070 of 1,597,351 trades",
            repair: "repairing page seams: 0 of 87 blocks",
            pace: "",
            left: "",
          }
        )
        assert.deepStrictEqual(
          yield* walkView({
            ...walking,
            trades,
            repair: { done: 12, of: 87, perSecond: 0.07 },
          }),
          {
            walk: "Ajaib, 2026-11-12 (newest closed day)",
            phase: "",
            trades: "1,597,070 of 1,597,351 trades",
            repair: "repairing page seams: 12 of 87 blocks",
            pace: "",
            left: "18 min left",
          }
        )
        // The last block is walked again: nothing is left to time.
        assert.strictEqual(
          (yield* walkView({
            ...walking,
            trades,
            repair: { done: 87, of: 87, perSecond: 0.07 },
          })).left,
          ""
        )
        // A worker restarted in the repair pass has no first-pass trades.
        assert.deepStrictEqual(
          yield* walkView({
            ...walking,
            repair: { done: 3, of: 75, perSecond: 0.11 },
          }),
          {
            walk: "Ajaib, 2026-11-12 (newest closed day)",
            phase: "",
            trades: "",
            repair: "repairing page seams: 3 of 75 blocks",
            pace: "",
            left: "11 min left",
          }
        )
      })
  )

  it.effect("shows the History walk running, waiting or finished", () =>
    Effect.gen(function* () {
      const walking = {
        state: "walking",
        walk: "history",
        day: DAY,
        feed: "Stockbit",
      } as const
      const position = Option.some({
        oldest: WibDate.make("2026-10-01"),
        empty: 0,
        ended: false,
      })
      assert.strictEqual(
        yield* historyView(position, Option.some(walking)),
        "Running. Oldest day reached: 2026-10-01."
      )
      assert.strictEqual(
        yield* historyView(position, Option.some({ ...walking, walk: "gaps" })),
        "Waiting. Oldest day reached: 2026-10-01."
      )
      assert.strictEqual(
        yield* historyView(
          Option.map(position, (kept) => ({ ...kept, ended: true })),
          Option.none()
        ),
        "Finished. Oldest day reached: 2026-10-01."
      )
      assert.strictEqual(
        yield* historyView(Option.none(), Option.none()),
        "Waiting. No day reached yet."
      )
    })
  )
})

describe("the walk's phase", () => {
  it.effect("says what the walk is doing and since when, in WIB", () =>
    Effect.gen(function* () {
      const wibAt = (time: string) => Date.parse(`2026-11-20T${time}+07:00`)
      const phaseOf = (phase: WalkPhase) =>
        Effect.map(
          walkView({
            state: "walking",
            walk: "newest",
            day: DAY,
            feed: "Ajaib",
            phase,
          }),
          (view) => view.phase
        )
      assert.strictEqual(
        yield* phaseOf({ step: "awaiting-close", since: wibAt("16:35:10") }),
        "waiting for Ajaib's close since 16:35"
      )
      assert.strictEqual(
        yield* phaseOf({
          step: "awaiting-token",
          since: wibAt("17:02:00"),
          reloads: 0,
        }),
        "waiting for a fresh Ajaib token since 17:02"
      )
      assert.strictEqual(
        yield* phaseOf({
          step: "awaiting-token",
          since: wibAt("17:02:00"),
          reloads: 3,
        }),
        "waiting for a fresh Ajaib token since 17:02, tab reloaded 3×"
      )
      assert.strictEqual(
        yield* phaseOf({ step: "fetching", since: wibAt("17:05:00") }),
        "fetching since 17:05"
      )
    })
  )
})
