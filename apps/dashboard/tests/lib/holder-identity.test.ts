import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  holderMoves,
  type HolderPeriod,
  type MoveRule,
  trendOf,
} from "@/lib/holder-identity"

interface Holder {
  readonly key: string
  readonly shares: number
}

// Daily holders' rule: shares decide.
const BY_SHARES: MoveRule<Holder> = {
  change: (before, now) => Effect.succeed(now.shares - before.shares),
  shares: (holder) => Effect.succeed(holder.shares),
}

const day = (
  period: string,
  holders: ReadonlyArray<readonly [string, number]>
): HolderPeriod<Holder> => ({
  period,
  holders: holders.map(([key, shares]) => ({ key, shares })),
})

describe("Holder identity and moves", () => {
  it.effect(
    "tell same-key holders of a period apart by order, each against its own",
    () =>
      Effect.gen(function* () {
        const moves = yield* holderMoves(
          [
            day("2026-11-19", [
              ["CPGT", 100],
              ["CPGT", 50],
            ]),
            day("2026-11-20", [
              ["CPGT", 120],
              ["CPGT", 40],
            ]),
          ],
          BY_SHARES
        )
        const [first, second] = moves
        expect(second?.listed.map(({ move }) => move)).toEqual(["up", "down"])
        expect(second?.listed.map(({ holder }) => holder)).toEqual(
          first?.listed.map(({ holder }) => holder)
        )
        expect(new Set(second?.listed.map(({ holder }) => holder)).size).toBe(2)
      })
  )

  it.effect(
    "keep a returning holder's identity: New, returning, and out of history",
    () =>
      Effect.gen(function* () {
        const moves = yield* holderMoves(
          [
            day("2026-11-17", [
              ["A", 100],
              ["B", 50],
            ]),
            day("2026-11-18", [["A", 100]]),
            day("2026-11-19", [["A", 100]]),
            day("2026-11-20", [
              ["A", 100],
              ["B", 60],
            ]),
          ],
          BY_SHARES
        )
        const b = moves[0]?.listed[1]?.holder
        expect(
          moves[1]?.offList.map(({ holder, since }) => [holder, since])
        ).toEqual([[b, "2026-11-18"]])
        expect(
          moves[2]?.history.map(({ holder, since, last }) => [
            holder,
            since,
            last.shares,
          ])
        ).toEqual([[b, "2026-11-18", 50]])
        expect(moves[3]?.listed[1]).toMatchObject({
          holder: b,
          move: "new",
          returning: true,
          before: undefined,
        })
        expect(moves[3]?.history).toEqual([])
      })
  )

  it.effect(
    "trend a holder over the last 20 periods: share changes, in and out marks",
    () =>
      Effect.gen(function* () {
        const periods = [
          ...Array.from({ length: 19 }, (_, index) =>
            day(`P${String(index).padStart(2, "0")}`, [["A", 100]])
          ),
          day("P19", [
            ["A", 100],
            ["B", 10],
          ]),
          day("P20", [
            ["A", 90],
            ["B", 30],
          ]),
          day("P21", [["A", 95]]),
        ]
        const moves = yield* holderMoves(periods, BY_SHARES)
        const a = moves[0]?.listed[0]?.holder
        const b = moves[19]?.listed[1]?.holder
        if (a === undefined || b === undefined) return expect.fail()
        const trendA = yield* trendOf(moves, 21, a, BY_SHARES)
        expect(trendA).toHaveLength(20)
        expect(trendA.slice(-3)).toEqual([0, -10, 5])
        const trendB = yield* trendOf(moves, 21, b, BY_SHARES)
        expect(trendB.slice(-4)).toEqual([null, "in", 20, "out"])
        // The first period compares with nothing.
        expect(yield* trendOf(moves, 0, a, BY_SHARES)).toEqual([null])
      })
  )
})
