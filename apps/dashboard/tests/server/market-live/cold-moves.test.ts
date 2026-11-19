// The reconcile cron's backstop for moves to R2 (cold-moves.ts): it asks
// the newest recorded days still hot to move, and a failed ask asks on.
import { assert, describe, it } from "@effect/vitest"
import { WibDate, type RecordedDay } from "@workspace/relay"
import { Effect } from "effect"

import { askOlderMoves, askDueMoves } from "@/server/market-live/cold-moves"

// Twenty recorded days, 2026-10-01 to 2026-10-20, oldest first; the
// 2026-10-18 and 2026-10-05 cold.
const ROWS: ReadonlyArray<RecordedDay> = Array.from(
  { length: 20 },
  (_, index): RecordedDay => {
    const day = WibDate.make(`2026-10-${String(20 - index).padStart(2, "0")}`)
    const cold = day === "2026-10-18" || day === "2026-10-05"
    return {
      day,
      trades: 1,
      gap: false,
      ...(cold ? { cold: true as const } : {}),
    }
  }
).reverse()

describe("the reconcile cron's moves", () => {
  it.effect(
    "asks each of the newest 15 recorded days still hot, past a failed ask",
    () =>
      Effect.gen(function* () {
        const asked: Array<WibDate> = []
        yield* askDueMoves({
          listed: Effect.succeed(ROWS),
          ask: (day) =>
            Effect.suspend(() => {
              asked.push(day)
              return day === "2026-10-19"
                ? Effect.fail(new Error("Object unreachable"))
                : Effect.succeed(day === "2026-10-07")
            }),
        })
        assert.deepStrictEqual(asked, [
          "2026-10-20",
          "2026-10-19",
          "2026-10-17",
          "2026-10-16",
          "2026-10-15",
          "2026-10-14",
          "2026-10-13",
          "2026-10-12",
          "2026-10-11",
          "2026-10-10",
          "2026-10-09",
          "2026-10-08",
          "2026-10-07",
          "2026-10-06",
        ])
      })
  )
})

// Twenty-five recorded days, 2026-10-01 to 2026-10-25, oldest first; the
// 2026-10-05 cold. The newest 15 start at 2026-10-11.
const OLDER_ROWS: ReadonlyArray<RecordedDay> = Array.from(
  { length: 25 },
  (_, index): RecordedDay => {
    const day = WibDate.make(`2026-10-${String(index + 1).padStart(2, "0")}`)
    return {
      day,
      trades: 1,
      gap: false,
      ...(day === "2026-10-05" ? { cold: true as const } : {}),
    }
  }
)

describe("the older days' moves", () => {
  it.effect(
    "asks the hot days older than the newest 15, oldest first, until 3 move",
    () =>
      Effect.gen(function* () {
        const asked: Array<WibDate> = []
        yield* askOlderMoves({
          listed: Effect.succeed(OLDER_ROWS),
          ask: (day) =>
            Effect.suspend(() => {
              asked.push(day)
              // 10-01 still waits for its build; 10-02's object is
              // unreachable.
              if (day === "2026-10-02")
                return Effect.fail(new Error("Object unreachable"))
              return Effect.succeed(day !== "2026-10-01")
            }),
        })
        // 10-05 is cold; 10-03, 10-04 and 10-06 move.
        assert.deepStrictEqual(asked, [
          "2026-10-01",
          "2026-10-02",
          "2026-10-03",
          "2026-10-04",
          "2026-10-06",
        ])
      })
  )

  it.effect("asks nothing once every older day is cold", () =>
    Effect.gen(function* () {
      const asked: Array<WibDate> = []
      yield* askOlderMoves({
        listed: Effect.succeed(
          OLDER_ROWS.map((row) =>
            row.day < "2026-10-11" ? { ...row, cold: true as const } : row
          )
        ),
        ask: (day) => Effect.sync(() => (asked.push(day), true)),
      })
      assert.deepStrictEqual(asked, [])
    })
  )
})
