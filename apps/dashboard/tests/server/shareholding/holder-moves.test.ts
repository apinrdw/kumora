// The Holder moves page's Daily read, after a real archive run stored the
// trimmed above-5% fixtures (11, 12, 24 and 25 Jun, 19 and 20 Nov 2026) and
// real investor-type and above-5% parse runs parsed them and derived their
// moves, through the Holder moves view model.
import { assert, describe, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { type DailyHolderLine, dailyHolders } from "@/lib/daily-holders"
import {
  type HolderMoves,
  holderMovesView,
  type MoveLine,
  visibleLines,
} from "@/lib/holder-moves"
import { staleMoveDays } from "@/server/holdings/above-5-moves"
import { holderMovesRead } from "@/server/holdings/holder-moves"

import {
  archive,
  archiveAndParse,
  pageOf,
  parse,
  republish,
  type World,
  world,
} from "./above-5-world.ts"
import { above5Item } from "./fake-idx.ts"

const DAYS = [
  "2026-06-11",
  "2026-06-12",
  "2026-06-24",
  "2026-06-25",
  "2026-11-19",
  "2026-11-20",
]
const STOCKS = ["ASRI", "BIKE", "CPGT", "ENRG", "MAMIP", "NSSS", "TRUE"]

const parsed = Effect.gen(function* () {
  const w = world()
  yield* archiveAndParse(w, "cron-2026-11-25")
  return w
})

const readOf = (w: World, day?: string) =>
  holderMovesRead({
    kind: "daily",
    day: day === undefined ? undefined : WibDate.make(day),
  }).pipe(Effect.provide(w.holdings.layer))

const movesOf = Effect.fnUntraced(function* (w: World, day?: string) {
  const moves = yield* holderMovesView(yield* readOf(w, day))
  assert.isDefined(moves)
  return moves
})

// `day`'s lines are, stock by stock, the stock's Daily holders movers.
const assertDailyHolders = Effect.fnUntraced(function* (w: World, day: string) {
  const moves = yield* movesOf(w, day)
  for (const code of STOCKS) {
    const held = yield* dailyHolders((yield* pageOf(w, code)).dailyHolders, day)
    const expected =
      held?.dataDate === day
        ? [...held.listed, ...held.offList].filter(
            ({ move }) => move !== undefined && move !== "unchanged"
          )
        : []
    const shown = moves.lines.filter((line) => line.code === code)
    const of = (
      lines: ReadonlyArray<
        Omit<MoveLine, "code" | "issuerName" | "move"> & {
          readonly move: DailyHolderLine["move"]
        }
      >
    ) =>
      lines
        .map((line) =>
          JSON.stringify([
            line.holder,
            line.name,
            line.move,
            line.through,
            line.shareChange,
            line.stake,
            line.percentageChange,
            line.renamedFrom,
            line.aliases,
            line.trend,
          ])
        )
        .sort()
    assert.deepStrictEqual(of(shown), of(expected), `${code} ${day}`)
  }
})

const rows = (lines: ReadonlyArray<MoveLine>) =>
  lines.map(({ code, name, move }) => `${code} ${name}: ${move}`)

describe("Holder moves, Daily", () => {
  it.effect("opens on the newest parsed day, against the day before", () =>
    Effect.gen(function* () {
      const moves = yield* movesOf(yield* parsed)
      assert.strictEqual(moves.period, "2026-11-20")
      assert.strictEqual(moves.against, "2026-11-19")
      assert.strictEqual(moves.stockCount, 3)
      // By stock code, then most % first.
      assert.deepStrictEqual(rows(moves.lines), [
        "ENRG CGS INTERNATIONAL SEKURITAS INDONESIA: down",
        "ENRG MAYBANK SEKURITAS INDONESIA: up",
        "NSSS PT SAMUEL SEKURITAS INDONESIA: down",
        "TRUE PT PERINTIS TRINITI PROPERTI TBK: down",
      ])
    })
  )

  it.effect("on 20 Nov shows no rename or repeat block as a move", () =>
    Effect.gen(function* () {
      const moves = yield* movesOf(yield* parsed, "2026-11-20")
      // ENRG's Maybank, renamed with a trade, stays one holder, Up.
      const maybank = moves.lines.find(({ renamedFrom }) =>
        renamedFrom?.startsWith("PT MAYBANK")
      )
      assert.isDefined(maybank)
      assert.strictEqual(maybank.move, "up")
      assert.strictEqual(maybank.shareChange, 20_000)
      assert.strictEqual(maybank.through.join(" "), "ZP")
      // ASRI's 5 blocks on 19 Nov collapse to the 3 of 20 Nov: no move.
      assert.isFalse(moves.lines.some(({ code }) => code === "ASRI"))
      assert.deepStrictEqual(moves.counts, {
        new: 0,
        up: 1,
        down: 3,
        offList: 0,
      })
    })
  )

  it.effect("lists, for every day, each stock's Daily holders movers", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      for (const day of DAYS.slice(1)) yield* assertDailyHolders(w, day)
    })
  )

  it.effect("counts, in the filters and the rail, what its rows show", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      const views: Array<HolderMoves> = []
      for (const day of DAYS) views.push(yield* movesOf(w, day))
      for (const moves of views) {
        // The rail is every day with one before, the same on every day.
        assert.deepStrictEqual(
          moves.rail.map(({ period }) => period),
          DAYS.slice(1)
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
      assert.deepStrictEqual(
        views.find((each) => each.period === "2026-11-19")?.counts,
        {
          new: 3,
          up: 6,
          down: 3,
          offList: 1,
        }
      )
    })
  )

  it.effect("shows a holder leaving and one returning on 25 Jun", () =>
    Effect.gen(function* () {
      const moves = yield* movesOf(yield* parsed, "2026-06-25")
      const nsss = moves.lines.filter(({ code }) => code === "NSSS")
      const samuel = nsss.find(
        ({ name }) => name === "PT SAMUEL TUMBUH BERSAMA"
      )
      assert.isDefined(samuel)
      // Back after leaving on 12 Jun: New, under 5% before, its trend
      // marking it out and back in.
      assert.strictEqual(samuel.move, "new")
      assert.deepStrictEqual(samuel.stake, { now: 3430 })
      // Its Lots: its whole holding in, as on its Daily holders.
      assert.isAbove(samuel.shareChange ?? 0, 0)
      assert.deepStrictEqual(samuel.trend, [null, "out", null, "in"])
      const paradiso = nsss.find(
        ({ name }) => name === "PARADISO RESOURCES LTD"
      )
      assert.isDefined(paradiso)
      assert.strictEqual(paradiso.move, "off list")
      assert.deepStrictEqual(paradiso.stake, { before: 531 })
      assert.strictEqual(paradiso.through.join(" "), "IF")
    })
  )

  it.effect("has no moves on the first parsed day", () =>
    Effect.gen(function* () {
      const moves = yield* movesOf(yield* parsed, "2026-06-11")
      assert.strictEqual(moves.period, "2026-06-11")
      assert.isUndefined(moves.against)
      assert.deepStrictEqual(moves.lines, [])
    })
  )

  it.effect("opens the newest day for a day not parsed", () =>
    Effect.gen(function* () {
      const moves = yield* movesOf(yield* parsed, "2026-11-23")
      assert.strictEqual(moves.period, "2026-11-20")
    })
  )

  it.effect("has nothing to show before a day is parsed", () =>
    Effect.gen(function* () {
      const read = yield* readOf(world())
      assert.deepStrictEqual(read.periods, [])
      assert.isUndefined(yield* holderMovesView(read))
    })
  )

  it.effect(
    "filters by move and searches stock, issuer, holder and broker",
    () =>
      Effect.gen(function* () {
        const { lines } = yield* movesOf(yield* parsed, "2026-11-19")
        const shown = (
          filter: Parameters<typeof visibleLines>[1],
          search: string
        ) => Effect.map(visibleLines(lines, filter, search), rows)
        assert.deepStrictEqual(yield* shown("new", ""), [
          "ENRG CGS INTERNATIONAL SECURITIES HONG KONG LIMITED: new",
          "NSSS PT SAMUEL SEKURITAS INDONESIA: new",
          "TRUE PT PERINTIS TRINITI PROPERTI TBK: new",
        ])
        // A broker code matches Through, any case.
        assert.deepStrictEqual(yield* shown("all", " zp "), [
          "ASRI MANUNGGAL PRIME DEVELOPMENT, PT: up",
          "ASRI PT MAYBANK SEKURITAS INDONESIA - REGISTRAR: down",
          "ENRG PT MAYBANK SEKURITAS INDONESIA - REGISTRAR: up",
        ])
        assert.deepStrictEqual(yield* shown("down", "nsss"), [
          "NSSS PT SAMUEL INTERNATIONAL: down",
          "NSSS PT NUSANTARA MAKMUR LESTARI: down",
        ])
        assert.deepStrictEqual(yield* shown("all", "tumbuh"), [
          "NSSS PT SAMUEL TUMBUH BERSAMA: off list",
        ])
        const issuer = lines.find(({ code }) => code === "BIKE")?.issuerName
        assert.isDefined(issuer)
        assert.deepStrictEqual(
          yield* shown("all", issuer.slice(0, 12).toLowerCase()),
          ["BIKE SENDI: up"]
        )
        assert.deepStrictEqual(yield* shown("off list", "zp"), [])
      })
  )
})

describe("Holder moves, Daily, as the above-5% parse run derives them", () => {
  it.effect("derives each parsed day once", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      const stale = staleMoveDays().pipe(Effect.provide(w.holdings.layer))
      assert.deepStrictEqual(yield* stale, [])
      w.holdings.statements.length = 0
      const again = yield* parse(w, "cron-2026-11-26")
      assert.deepInclude(again, {
        outcome: "complete",
        monthsParsed: 0,
        parseFailures: [],
      })
      // Nothing new was parsed, so no day's lines were replaced.
      assert.isFalse(
        w.holdings.statements.some(({ sql }) =>
          sql.includes("INTO above_5_move_day")
        )
      )
    })
  )

  it.effect("derives a day parsed late, and again every day after it", () =>
    Effect.gen(function* () {
      const w = world()
      const late = above5Item("2026-06-24")
      const listing = w.idx.listing
      w.idx.listing = listing.filter((item) => item !== late)
      yield* archiveAndParse(w, "cron-2026-11-25")
      const before = yield* movesOf(w, "2026-06-25")
      assert.strictEqual(before.against, "2026-06-12")

      w.idx.listing = listing
      yield* archive(w, "cron-2026-11-26T13")
      const result = yield* parse(w, "cron-2026-11-26")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 1 })
      const after = yield* movesOf(w, "2026-06-25")
      assert.strictEqual(after.against, "2026-06-24")
      assert.deepStrictEqual(
        after.lines
          .filter(({ name }) => name === "PT SAMUEL TUMBUH BERSAMA")
          .map(({ trend }) => trend),
        [[null, "out", null, "in"]]
      )
      for (const day of DAYS.slice(1)) yield* assertDailyHolders(w, day)
    })
  )

  it.effect("derives a day parsed again from its new version", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      republish(w, "2026-11-20", "republished")
      yield* archive(w, "cron-2026-11-26T13")
      yield* parse(w, "cron-2026-11-26")
      // 20 Nov is BIKE alone now: every other holder of 19 Nov left.
      const moves = yield* movesOf(w, "2026-11-20")
      assert.isTrue(
        moves.lines.every(
          ({ code, move }) => code === "BIKE" || move === "off list"
        )
      )
      assert.isAbove(moves.counts.offList, 10)
      yield* assertDailyHolders(w, "2026-11-20")
    })
  )

  it.effect("keeps a day's lines when its new version fails to parse", () =>
    Effect.gen(function* () {
      const w = yield* parsed
      const before = yield* movesOf(w, "2026-11-20")
      republish(w, "2026-11-20", "unknown-header")
      yield* archive(w, "cron-2026-11-26T13")
      const result = yield* parse(w, "cron-2026-11-26")
      assert.deepInclude(result, { outcome: "partial", monthsParsed: 0 })
      assert.deepStrictEqual(yield* movesOf(w, "2026-11-20"), before)
      yield* assertDailyHolders(w, "2026-11-20")
    })
  )

  it.effect(
    "keeps a day's lines when deriving it fails, and derives it on the next run",
    () =>
      Effect.gen(function* () {
        const w = yield* parsed
        const before = yield* movesOf(w, "2026-11-20")
        republish(w, "2026-11-20", "republished")
        yield* archive(w, "cron-2026-11-26T13")
        w.holdings.failBatch = (sql) =>
          sql.some((statement) =>
            statement.includes("INSERT INTO above_5_move")
          )
        const failed = yield* parse(w, "cron-2026-11-26")
        assert.deepInclude(failed, { outcome: "partial", monthsParsed: 1 })
        assert.deepStrictEqual(
          failed.parseFailures.map(({ date, message }) => [
            date,
            message.startsWith("Holder moves: "),
          ]),
          [["2026-11-20", true]]
        )
        // Its lines are the version before's, whole.
        assert.deepStrictEqual(yield* movesOf(w, "2026-11-20"), before)

        w.holdings.failBatch = undefined
        const retried = yield* parse(w, "cron-2026-11-27")
        assert.deepInclude(retried, {
          outcome: "complete",
          monthsParsed: 0,
          parseFailures: [],
        })
        yield* assertDailyHolders(w, "2026-11-20")
      })
  )
})
