// The Holder moves page's Monthly read, after a real archive run stored the
// trimmed above-1% fixtures (Feb, Apr, Aug, Sep and Oct 2026) and a real
// above-1% parse run parsed them, through the Holder moves view model.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  type HolderMoves,
  holderMovesView,
  type MoveLine,
} from "@/lib/holder-moves"
import { majorHolders } from "@/lib/major-holders"
import { Month } from "@/domain/holdings"
import { holderMovesRead } from "@/server/holdings/holder-moves"
import { above1ParseRuns } from "@/server/shareholding/above-1-parse"

import {
  archive,
  pageOf,
  runParse,
  type World,
  world,
} from "./above-5-world.ts"

const MONTHS = [
  "2026-02-27",
  "2026-04-30",
  "2026-08-31",
  "2026-09-30",
  "2026-10-30",
]
const STOCKS = ["AADI", "BSDE", "FLMC", "RALS", "TLKM", "TRUE"]

const parsed = Effect.gen(function* () {
  const w = world({ withAbove1: true })
  yield* archive(w, "cron-2026-11-25T13")
  yield* runParse(above1ParseRuns)(w, "cron-2026-11-25")
  return w
})

const readOf = (w: World, month?: string) =>
  holderMovesRead({
    kind: "monthly",
    month: month === undefined ? undefined : Month.make(month),
  }).pipe(Effect.provide(w.holdings.layer))

const movesOf = Effect.fnUntraced(function* (w: World, month?: string) {
  const moves = yield* holderMovesView(yield* readOf(w, month))
  assert.isDefined(moves)
  return moves
})

const DANANTARA = "PERUSAHAAN PERSEROAN (PERSERO) PT DANANTARA ASSET MANAGEMENT"

describe("Holder moves, Monthly", () => {
  it.effect("opens on the newest parsed month, against the month before", () =>
    Effect.gen(function* () {
      const moves = yield* movesOf(yield* parsed)
      assert.strictEqual(moves.kind, "monthly")
      assert.strictEqual(moves.period, "2026-10-30")
      assert.strictEqual(moves.against, "2026-09-30")
      const stakes = moves.lines.map(({ stake }) => stake.now ?? stake.before)
      // By stock code, then most % first.
      assert.deepStrictEqual(
        moves.lines.map(({ code }) => code),
        moves.lines.map(({ code }) => code).sort()
      )
      for (const [i, line] of moves.lines.entries())
        if (moves.lines[i - 1]?.code === line.code)
          assert.isAtMost(stakes[i] ?? 0, stakes[i - 1] ?? 0)
      // No Through on a month.
      assert.isTrue(moves.lines.every(({ through }) => through.length === 0))
    })
  )

  it.effect(
    "lists, for every month, each stock's Major holders chips that moved",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        for (const month of MONTHS.slice(1)) {
          const moves = yield* movesOf(w, month.slice(0, 7))
          assert.strictEqual(moves.period, month)
          for (const code of STOCKS) {
            const held = yield* majorHolders(
              (yield* pageOf(w, code)).majorHolders,
              month.slice(0, 7)
            )
            const expected =
              held?.dataDate === month
                ? [...held.listed, ...held.offList]
                    .filter(
                      ({ change }) =>
                        change !== undefined && change !== "unchanged"
                    )
                    .map((line) =>
                      JSON.stringify([
                        line.holder,
                        line.name,
                        line.change,
                        line.shareChange,
                        line.percentageChange,
                        line.trend,
                      ])
                    )
                    .sort()
                : []
            const shown = moves.lines
              .filter((line) => line.code === code)
              .map((line) =>
                JSON.stringify([
                  line.holder,
                  line.name,
                  line.move,
                  line.shareChange,
                  line.percentageChange,
                  line.trend,
                ])
              )
              .sort()
            assert.deepStrictEqual(shown, expected, `${code} ${month}`)
          }
        }
      })
  )

  it.effect("shows TLKM's Danantara leaving in April and back in August", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      const danantara = (moves: HolderMoves) =>
        moves.lines.find(
          ({ code, name }) => code === "TLKM" && name === DANANTARA
        )
      const april = danantara(yield* movesOf(w, "2026-04"))
      assert.strictEqual(april?.move, "off list")
      assert.isDefined(april?.stake.before)
      assert.isUndefined(april?.stake.now)
      const august = danantara(yield* movesOf(w, "2026-08"))
      assert.strictEqual(august?.move, "new")
      assert.isUndefined(august?.stake.before)
      assert.isUndefined(august?.shareChange)
      assert.deepStrictEqual(august?.trend, [null, "out", "in"])
    })
  )

  it.effect("counts, in the filters and the rail, what its rows show", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      const views: Array<HolderMoves> = []
      for (const month of MONTHS)
        views.push(yield* movesOf(w, month.slice(0, 7)))
      for (const moves of views) {
        assert.deepStrictEqual(
          moves.rail.map(({ period }) => period),
          MONTHS.slice(1)
        )
        for (const { period, counts } of moves.rail)
          assert.deepStrictEqual(
            counts,
            views.find((each) => each.period === period)?.counts,
            period
          )
      }
      const counted = (moves: HolderMoves, move: MoveLine["move"]) =>
        moves.lines.filter((line) => line.move === move).length
      for (const moves of views)
        assert.deepStrictEqual(moves.counts, {
          new: counted(moves, "new"),
          up: counted(moves, "up"),
          down: counted(moves, "down"),
          offList: counted(moves, "off list"),
        })
    })
  )

  it.effect("has no moves on the first parsed month", () =>
    Effect.gen(function* () {
      const moves = yield* movesOf(yield* parsed, "2026-02")
      assert.strictEqual(moves.period, "2026-02-27")
      assert.isUndefined(moves.against)
      assert.deepStrictEqual(moves.lines, [])
    })
  )

  it.effect("opens the newest month for a month not parsed", () =>
    Effect.gen(function* () {
      const moves = yield* movesOf(yield* parsed, "2026-03")
      assert.strictEqual(moves.period, "2026-10-30")
    })
  )

  it.effect("has nothing to show before a month is parsed", () =>
    Effect.gen(function* () {
      const read = yield* readOf(world())
      assert.deepStrictEqual(read.periods, [])
      assert.isUndefined(yield* holderMovesView(read))
    })
  )

  it.effect("reads only the months the moving stocks' rows need", () =>
    Effect.gen(function* () {
      const read = yield* readOf(yield* parsed, "2026-04")
      assert.strictEqual(read.kind, "monthly")
      const monthsOf = (code: string) =>
        read.kind === "monthly"
          ? read.stocks
              .find((stock) => stock.code === code)
              ?.months.map(({ dataDate }) => dataDate)
          : undefined
      // AADI's holders in April are February's, unchanged: only the rail's
      // later months and the month before each are read.
      assert.deepStrictEqual(monthsOf("AADI"), MONTHS.slice(1))
      // TLKM moved in April: its February too, for the trend.
      assert.deepStrictEqual(monthsOf("TLKM"), MONTHS)
    })
  )
})
