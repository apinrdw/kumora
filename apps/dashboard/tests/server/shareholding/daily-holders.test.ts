// The stock page's Daily holders, read after a real archive run stored the
// trimmed above-5% fixtures (11, 12, 24 and 25 Jun, 19 and 20 Nov 2026) and
// real investor-type and above-5% parse runs parsed them, through the Daily
// holders view model.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { type DailyHolderLine, dailyHolders } from "@/lib/daily-holders"

import { archiveAndParse, pageOf, world } from "./above-5-world.ts"

const parsed = Effect.gen(function* () {
  const w = world()
  yield* archiveAndParse(w, "cron-2026-11-25")
  return w
})

// `code`'s Daily holders on `day`, or its newest day.
const shown = Effect.fnUntraced(function* (code: string, day?: string) {
  const page = yield* pageOf(yield* parsed, code)
  const holders = yield* dailyHolders(page.dailyHolders, day)
  assert.isDefined(holders, code)
  return holders
})

const named = (lines: ReadonlyArray<DailyHolderLine>, name: string) => {
  const line = lines.find((each) => each.name === name)
  assert.isDefined(line, name)
  return line
}

const moves = (lines: ReadonlyArray<DailyHolderLine>) =>
  lines.map(({ name, move }) => [name, move])

describe("the stock page's Daily holders", () => {
  it.effect("open a stock's newest parsed day, against the day before", () =>
    Effect.gen(function* () {
      const enrg = yield* shown("ENRG")
      assert.strictEqual(enrg.dataDate, "2026-11-20")
      assert.strictEqual(enrg.against, "2026-11-19")
      assert.deepStrictEqual(enrg.days, [
        "2026-06-11",
        "2026-06-12",
        "2026-06-24",
        "2026-06-25",
        "2026-11-19",
        "2026-11-20",
      ])
      assert.strictEqual(enrg.totalHundredths, 5012)
      assert.deepStrictEqual(enrg.counts, {
        new: 0,
        up: 1,
        down: 1,
        offList: 0,
      })
      // Most % first.
      assert.deepStrictEqual(
        enrg.listed.map(({ stake }) => stake.now),
        [1746, 1196, 728, 685, 657]
      )
    })
  )

  it.effect("show no moves or changes on the stock's first parsed day", () =>
    Effect.gen(function* () {
      const first = yield* shown("ENRG", "2026-06-11")
      assert.isUndefined(first.against)
      assert.isUndefined(first.counts)
      for (const line of first.listed) {
        assert.isUndefined(line.move)
        assert.isUndefined(line.shareChange)
        assert.isUndefined(line.percentageChange)
        assert.isUndefined(line.stake.before)
        assert.isTrue(
          line.accounts.every(({ shareChange }) => shareChange === undefined)
        )
      }
    })
  )

  it.effect(
    "collapse ASRI's repeat blocks into one holder with aliases, before 20 Nov",
    () =>
      Effect.gen(function* () {
        const before = yield* shown("ASRI", "2026-11-19")
        assert.lengthOf(before.listed, 3)
        assert.deepInclude(
          named(before.listed, "MANUNGGAL PRIME DEVELOPMENT, PT"),
          {
            aliases: [
              "MANUNGGAL PRIME DEVELOPMENT,PT",
              "PT. MANUNGGAL PRIME DEVELOPMENT",
            ],
            move: "up",
          }
        )
        // Under 100% held: 40.23%, not the repeats' sum.
        assert.strictEqual(before.totalHundredths, 4023)
        // From 20 Nov IDX lists it once, and it stays the same holder.
        const after = yield* shown("ASRI", "2026-11-20")
        assert.deepInclude(
          named(after.listed, "PT. MANUNGGAL PRIME DEVELOPMENT"),
          {
            aliases: [],
            move: "unchanged",
          }
        )
        assert.isEmpty(after.offList)
      })
  )

  it.effect(
    "keep ENRG's renamed Maybank as one holder, Up 200 lots by shares",
    () =>
      Effect.gen(function* () {
        const enrg = yield* shown("ENRG", "2026-11-20")
        assert.deepInclude(named(enrg.listed, "MAYBANK SEKURITAS INDONESIA"), {
          renamedFrom: "PT MAYBANK SEKURITAS INDONESIA - REGISTRAR",
          move: "up",
          shareChange: 20_000,
          stake: { before: 657, now: 657 },
        })
        assert.isEmpty(enrg.offList)
        assert.isEmpty(enrg.history)
      })
  )

  it.effect(
    "pair ENRG's shuffled Shima accounts, showing no account move",
    () =>
      Effect.gen(function* () {
        const shima = named(
          (yield* shown("ENRG", "2026-11-20")).listed,
          "PT Shima Global Kapital"
        )
        assert.lengthOf(shima.accounts, 8)
        assert.isTrue(
          shima.accounts.every(({ shareChange }) => shareChange === 0)
        )
        // Largest first.
        assert.deepStrictEqual(
          shima.accounts
            .slice(0, 2)
            .map(({ custodian, shares }) => [custodian, shares]),
          [
            ["PT KB VALBURY SEKURITAS", 3_000_000_000],
            ["PT KB VALBURY SEKURITAS", 2_359_045_944],
          ]
        )
        // The account that moved, Maybank's 220,200 by 20,000.
        const maybank = named(
          (yield* shown("ENRG", "2026-11-20")).listed,
          "MAYBANK SEKURITAS INDONESIA"
        )
        assert.deepStrictEqual(
          maybank.accounts.map(({ shares, shareChange }) => [
            shares,
            shareChange,
          ]),
          [
            [2_617_966_000, 0],
            [220_200, 20_000],
          ]
        )
      })
  )

  it.effect(
    "show ENRG's holders Unchanged with a % change when its listed shares change",
    () =>
      Effect.gen(function* () {
        const enrg = yield* shown("ENRG", "2026-06-12")
        assert.deepInclude(named(enrg.listed, "PT SHIMA GLOBAL KAPITAL"), {
          move: "unchanged",
          shareChange: 0,
          percentageChange: -14,
        })
        assert.deepInclude(
          named(enrg.listed, "PT TRIMEGAH SEKURITAS INDONESIA TBK"),
          { move: "unchanged", percentageChange: -9 }
        )
      })
  )

  it.effect(
    "show a holder that left and returned as one, with one history",
    () =>
      Effect.gen(function* () {
        // PT SAMUEL TUMBUH BERSAMA: listed 11 Jun, off list 12 Jun, back 25
        // Jun, off list again 19 Nov.
        const left = yield* shown("NSSS", "2026-06-12")
        assert.deepInclude(named(left.offList, "PT SAMUEL TUMBUH BERSAMA"), {
          move: "off list",
          stake: { before: 587 },
          offListSince: undefined,
        })
        const away = yield* shown("NSSS", "2026-06-24")
        assert.deepInclude(named(away.history, "PT SAMUEL TUMBUH BERSAMA"), {
          offListSince: "2026-06-12",
        })
        assert.deepStrictEqual(moves(away.listed).at(-1), [
          "PARADISO RESOURCES LTD",
          "new",
        ])
        const back = yield* shown("NSSS", "2026-06-25")
        const returned = named(back.listed, "PT SAMUEL TUMBUH BERSAMA")
        assert.deepInclude(returned, {
          move: "new",
          stake: { now: 3430 },
          shareChange: undefined,
        })
        assert.deepStrictEqual(returned.trend, [null, "out", null, "in"])
        // Never also an earlier holder.
        assert.notInclude(
          back.history.map(({ name }) => name),
          "PT SAMUEL TUMBUH BERSAMA"
        )
        assert.strictEqual(
          named(back.listed, "PT SAMUEL TUMBUH BERSAMA").holder,
          named(left.offList, "PT SAMUEL TUMBUH BERSAMA").holder
        )
        // Earlier holders: newest exit first.
        const newest = yield* shown("NSSS")
        assert.deepStrictEqual(
          newest.history.map(({ name, offListSince }) => [name, offListSince]),
          [
            ["PT SAMUEL TUMBUH BERSAMA", "2026-11-19"],
            ["PARADISO RESOURCES LTD", "2026-06-25"],
          ]
        )
      })
  )

  it.effect(
    "tell CPGT's two investors under one name apart, each against its own",
    () =>
      Effect.gen(function* () {
        const cpgt = yield* shown("CPGT", "2026-06-12")
        const argentum = cpgt.listed.filter(
          ({ name }) => name === "ASIA ARGENTUM ASSETS HONG KONG LIMITED"
        )
        assert.deepStrictEqual(
          argentum.map(({ stake, move }) => [stake.now, move]),
          [
            [2095, "unchanged"],
            [817, "unchanged"],
          ]
        )
      })
  )

  it.effect(
    "show a stock the above-1% report leaves out, its holders by origin",
    () =>
      Effect.gen(function* () {
        const mamip = yield* shown("MAMIP")
        assert.strictEqual(mamip.listedShares, 6_000_000)
        assert.lengthOf(mamip.listed, 5)
        const cpgt = yield* shown("CPGT")
        assert.isTrue(cpgt.listed.every(({ origin }) => origin === "foreign"))
      })
  )

  it.effect("show nothing for a stock without an above-5% holder", () =>
    Effect.gen(function* () {
      const page = yield* pageOf(yield* parsed, "BBCA")
      assert.lengthOf(page.dailyHolders, 6)
      assert.isUndefined(yield* dailyHolders(page.dailyHolders, undefined))
    })
  )
})
