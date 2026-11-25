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
import { staleMoveMonths } from "@/server/holdings/above-1-moves"
import { holderMovesRead } from "@/server/holdings/holder-moves"
import { above1ParseRuns } from "@/server/shareholding/above-1-parse"

import {
  archive,
  pageOf,
  republishAbove1,
  runParse,
  type World,
  world,
} from "./above-5-world.ts"
import { above1Item } from "./fake-idx.ts"

const MONTHS = [
  "2026-02-27",
  "2026-04-30",
  "2026-08-31",
  "2026-09-30",
  "2026-10-30",
]
const STOCKS = ["AADI", "BSDE", "FLMC", "RALS", "TLKM", "TRUE"]

const parseAbove1 = runParse(above1ParseRuns)

const parsed = Effect.gen(function* () {
  const w = world({ withAbove1: true })
  yield* archive(w, "cron-2026-11-25T13")
  yield* parseAbove1(w, "cron-2026-11-25")
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

// `month`'s lines are, stock by stock, the stock's Major holders chips
// that moved.
const assertMajorHolders = Effect.fnUntraced(function* (
  w: World,
  month: string
) {
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
              ({ change }) => change !== undefined && change !== "unchanged"
            )
            .map((line) =>
              JSON.stringify([
                line.holder,
                line.name,
                line.change,
                // Lots: a New holder's whole holding in, an Off-list one's
                // last out.
                line.change === "new"
                  ? line.total
                  : line.change === "off list"
                    ? -line.total
                    : line.shareChange,
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
        for (const month of MONTHS.slice(1)) yield* assertMajorHolders(w, month)
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
      assert.isBelow(april?.shareChange ?? 0, 0)
      const august = danantara(yield* movesOf(w, "2026-08"))
      assert.strictEqual(august?.move, "new")
      assert.isUndefined(august?.stake.before)
      assert.isAbove(august?.shareChange ?? 0, 0)
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
})

describe("Holder moves, Monthly, as the above-1% parse run derives them", () => {
  it.effect("derives each parsed month once", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      const stale = staleMoveMonths().pipe(Effect.provide(w.holdings.layer))
      assert.deepStrictEqual(yield* stale, [])
      w.holdings.statements.length = 0
      const again = yield* parseAbove1(w, "cron-2026-11-26")
      assert.deepInclude(again, {
        outcome: "complete",
        monthsParsed: 0,
        parseFailures: [],
      })
      // Nothing new was parsed, so no month's lines were replaced.
      assert.isFalse(
        w.holdings.statements.some(({ sql }) =>
          sql.includes("INTO above_1_move_month")
        )
      )
    })
  )

  it.effect(
    "derives a month parsed late, and again the months after it whose Trend reads it",
    () =>
      Effect.gen(function* () {
        const w = world({ withAbove1: true })
        const late = above1Item("2026-04-30")
        const listing = w.idx.listing
        w.idx.listing = listing.filter((item) => item !== late)
        yield* archive(w, "cron-2026-11-25T13")
        yield* parseAbove1(w, "cron-2026-11-25")
        const before = yield* movesOf(w, "2026-08")
        assert.strictEqual(before.against, "2026-02-27")

        w.idx.listing = listing
        yield* archive(w, "cron-2026-11-26T13")
        const result = yield* parseAbove1(w, "cron-2026-11-26")
        assert.deepInclude(result, { outcome: "complete", monthsParsed: 1 })
        const after = yield* movesOf(w, "2026-08")
        assert.strictEqual(after.against, "2026-04-30")
        assert.deepStrictEqual(
          after.lines
            .filter(({ code, name }) => code === "TLKM" && name === DANANTARA)
            .map(({ move, trend }) => [move, trend]),
          [["new", [null, "out", "in"]]]
        )
        for (const month of MONTHS.slice(1)) yield* assertMajorHolders(w, month)
      })
  )

  it.effect("derives a month parsed again from its new version", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      const before = yield* movesOf(w, "2026-10")
      republishAbove1(w, "2026-10-30", "split")
      yield* archive(w, "cron-2026-11-26T13")
      yield* parseAbove1(w, "cron-2026-11-26")
      assert.notDeepEqual(yield* movesOf(w, "2026-10"), before)
      yield* assertMajorHolders(w, "2026-10-30")
    })
  )

  it.effect("keeps a month's lines when its new version fails to parse", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      const before = yield* movesOf(w, "2026-10")
      republishAbove1(w, "2026-10-30", "unknown-header")
      yield* archive(w, "cron-2026-11-26T13")
      const result = yield* parseAbove1(w, "cron-2026-11-26")
      assert.deepInclude(result, { outcome: "partial", monthsParsed: 0 })
      assert.deepStrictEqual(yield* movesOf(w, "2026-10"), before)
      yield* assertMajorHolders(w, "2026-10-30")
    })
  )

  it.effect(
    "keeps a month's lines when deriving it fails, and derives it on the next run",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        const before = yield* movesOf(w, "2026-10")
        republishAbove1(w, "2026-10-30", "split")
        yield* archive(w, "cron-2026-11-26T13")
        w.holdings.failBatch = (sql) =>
          sql.some((statement) =>
            statement.includes("INSERT INTO above_1_move")
          )
        const failed = yield* parseAbove1(w, "cron-2026-11-26")
        assert.deepInclude(failed, { outcome: "partial", monthsParsed: 1 })
        assert.deepStrictEqual(
          failed.parseFailures.map(({ date, message }) => [
            date,
            message.startsWith("Holder moves: "),
          ]),
          [["2026-10-30", true]]
        )
        // Its lines are the version before's, whole.
        assert.deepStrictEqual(yield* movesOf(w, "2026-10"), before)

        w.holdings.failBatch = undefined
        const retried = yield* parseAbove1(w, "cron-2026-11-27")
        assert.deepInclude(retried, {
          outcome: "complete",
          monthsParsed: 0,
          parseFailures: [],
        })
        yield* assertMajorHolders(w, "2026-10-30")
      })
  )
})
