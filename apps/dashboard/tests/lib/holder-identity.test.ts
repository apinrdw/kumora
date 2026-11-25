import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  collapseRepeats,
  holderMoves,
  type HolderPeriod,
  type MoveRule,
  trendOf,
} from "@/lib/holder-identity"

interface Holder {
  readonly key: string
  readonly shares: number
  readonly accounts?: ReadonlyArray<string>
}

// Daily holders' rule: shares decide, and a gone holder and a new one are
// one renamed when their shares are equal or they share an account.
const BY_SHARES: MoveRule<Holder> = {
  change: (before, now) => Effect.succeed(now.shares - before.shares),
  shares: (holder) => Effect.succeed(holder.shares),
  renamed: (gone, arrived) =>
    Effect.succeed(
      gone.shares === arrived.shares ||
        (gone.accounts ?? []).some((account) =>
          (arrived.accounts ?? []).includes(account)
        )
    ),
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

  it.effect(
    "compare across a reported period with no holders: all off list, then new",
    () =>
      Effect.gen(function* () {
        const moves = yield* holderMoves(
          [
            day("2026-11-18", [["A", 100]]),
            day("2026-11-19", []),
            day("2026-11-20", [["A", 100]]),
          ],
          BY_SHARES
        )
        const a = moves[0]?.listed[0]?.holder
        expect(moves[1]?.comparison).toEqual({
          kind: "compared",
          period: "2026-11-18",
        })
        expect(moves[1]?.offList.map(({ holder }) => holder)).toEqual([a])
        expect(moves[2]?.listed[0]).toMatchObject({
          holder: a,
          move: "new",
          returning: true,
        })
      })
  )

  it.effect("compare nothing across a period without a report", () =>
    Effect.gen(function* () {
      const moves = yield* holderMoves(
        [
          day("2026-09-30", [["A", 100]]),
          { period: "2026-10-30", holders: undefined },
          day("2026-11-30", [["A", 120]]),
        ],
        BY_SHARES
      )
      expect(moves[1]?.listed).toEqual([])
      expect(moves[2]?.comparison).toEqual({
        kind: "gap",
        period: "2026-10-30",
      })
      expect(moves[2]?.listed[0]?.move).toBeUndefined()
    })
  )

  it.effect(
    "keep a renamed holder's identity, by equal shares or a shared account",
    () =>
      Effect.gen(function* () {
        const moves = yield* holderMoves(
          [
            {
              period: "2026-11-19",
              holders: [
                { key: "MAYBANK REGISTRAR", shares: 100, accounts: ["ZP 1"] },
                { key: "OLD NAME", shares: 50, accounts: ["XA 1"] },
                { key: "GONE", shares: 70, accounts: ["BQ 1"] },
              ],
            },
            {
              period: "2026-11-20",
              holders: [
                { key: "MAYBANK", shares: 120, accounts: ["ZP 1", "ZP 2"] },
                { key: "NEW NAME", shares: 50, accounts: ["KI 1"] },
                { key: "STRANGER", shares: 70.5, accounts: ["CC 1"] },
              ],
            },
          ],
          BY_SHARES
        )
        const [before, now] = moves
        expect(now?.listed.map(({ holder }) => holder)).toEqual([
          before?.listed[0]?.holder,
          before?.listed[1]?.holder,
          expect.not.stringMatching(/^GONE/),
        ])
        expect(now?.listed.map(({ move, renamed }) => [move, renamed])).toEqual(
          [
            ["up", true],
            ["unchanged", true],
            ["new", false],
          ]
        )
        expect(now?.offList.map(({ holder }) => holder)).toEqual([
          before?.listed[2]?.holder,
        ])
      })
  )

  it.effect(
    "keep a renamed holder's identity when its old name is listed again before it",
    () =>
      Effect.gen(function* () {
        const moves = yield* holderMoves(
          [
            day("2026-11-18", [["A", 100]]),
            day("2026-11-19", [["B", 100]]),
            day("2026-11-20", [
              ["A", 30],
              ["B", 100],
            ]),
          ],
          BY_SHARES
        )
        const renamed = moves[1]?.listed[0]?.holder
        expect(moves[2]?.listed[1]?.holder).toBe(renamed)
        expect(moves[2]?.listed[0]?.holder).not.toBe(renamed)
        expect(
          moves[2]?.listed.map(({ move, returning }) => [move, returning])
        ).toEqual([
          ["new", false],
          ["unchanged", false],
        ])
        expect(moves[2]?.offList).toEqual([])
      })
  )

  it.effect(
    "rename nothing without a rename rule: Major holders match by key only",
    () =>
      Effect.gen(function* () {
        const { renamed: _, ...byKey } = BY_SHARES
        const moves = yield* holderMoves(
          [
            day("2026-09-30", [["OLD", 100]]),
            day("2026-10-30", [["NEW", 100]]),
          ],
          byKey
        )
        expect(moves[1]?.listed[0]?.move).toBe("new")
        expect(moves[1]?.offList).toHaveLength(1)
      })
  )

  it.effect(
    "collapse a block repeating an earlier one into it, its name an alias",
    () =>
      Effect.gen(function* () {
        const blocks = [
          { name: "PT MANUNGGAL", shares: 100 },
          { name: "OTHER", shares: 40 },
          { name: "MANUNGGAL, PT", shares: 100 },
          { name: "PT. MANUNGGAL", shares: 100 },
          { name: "PT MANUNGGAL", shares: 100 },
        ]
        const collapsed = yield* collapseRepeats(blocks, ({ shares }) =>
          Effect.succeed(String(shares))
        )
        expect(
          collapsed.map(({ holder, aliases }) => [holder.name, aliases])
        ).toEqual([
          ["PT MANUNGGAL", ["MANUNGGAL, PT", "PT. MANUNGGAL"]],
          ["OTHER", []],
        ])
      })
  )
})
