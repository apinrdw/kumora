// The Above-5% parse run: the shareholding archive's daily holders-above-5%
// reports parsed into above-5% holders.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { ParseRunResult } from "@/server/holdings/parse-run-result"
import { above1ParseRuns } from "@/server/shareholding/above-1-parse"

import {
  archive,
  archiveAndParse,
  heldOn,
  pageOf,
  parse,
  republish,
  runParse,
  type World,
  world,
} from "./above-5-world.ts"
import type { BrokenAbove5Fixture } from "./fake-idx.ts"
import {
  archiveDbOf,
  shareholdingParse,
  type ShareholdingParseKind,
  storedRun,
} from "../archive/runs.ts"

// A parse run's record as the admin page reads it.
const runRecord = (
  { bucket }: World,
  kind: ShareholdingParseKind,
  id: string
) =>
  Schema.decodeUnknownSync(ParseRunResult)(
    storedRun(archiveDbOf(bucket), shareholdingParse(kind), id)
  )

const holderNamed = Effect.fnUntraced(function* (
  w: World,
  dataDate: string,
  code: string,
  name: string
) {
  const holder = (yield* heldOn(w, dataDate, code)).find(
    (each) => each.name === name
  )
  assert.isDefined(holder, `${dataDate} ${code} ${name}`)
  return holder
})

describe("an above-5% parse run", () => {
  it.effect("parses every archived above-5% day on its first run", () =>
    Effect.gen(function* () {
      const w = world()
      const result = yield* archiveAndParse(w, "cron-2026-11-25")
      assert.deepInclude(result, {
        outcome: "complete",
        monthsParsed: 6,
        parseFailures: [],
      })
      assert.deepStrictEqual(runRecord(w, "above-5", "cron-2026-11-25"), result)

      // BIKE's SENDI: `75,176,540` text, `20.6` read as 20,600 and `765` as
      // 765,000, the one reading that sums to its `75,962,140`.
      const sendi = yield* holderNamed(w, "2026-06-11", "BIKE", "SENDI")
      // No classification report here: the page names BIKE as its newest
      // above-5% report does, after its issuer's rename.
      assert.strictEqual(
        (yield* pageOf(w, "BIKE")).issuerName,
        "BHINEKA INOVASI KETAHANAN ENERGI Tbk, PT"
      )
      assert.deepInclude(sendi, {
        scripless: 75_962_140,
        percentageHundredths: 587,
      })
      assert.deepStrictEqual(
        sendi.accounts.map(({ scripless }) => scripless),
        [75_176_540, 20_600, 765_000]
      )
      // 19 Nov's fourth account, `57.4`, is 57,400.
      assert.deepStrictEqual(
        (yield* holderNamed(w, "2026-11-19", "BIKE", "SENDI")).accounts.map(
          ({ scripless }) => scripless
        ),
        [1_015_200, 57_400, 75_176_540, 20_600]
      )

      // MAMIP's single accounts, against its 6,000,000 listed shares:
      // `500` at 8.33% is 500,000 and `863` at 14.38% is 863,000; `447.5`
      // is 447,500.
      assert.deepStrictEqual(
        (yield* heldOn(w, "2026-06-11", "MAMIP")).map(
          ({ name, scripless, percentageHundredths, accounts }) => [
            name,
            scripless,
            percentageHundredths,
            accounts.map((account) => account.scripless),
          ]
        ),
        [
          ["ONGKO DARMAWAN", 500_000, 833, [500_000]],
          ["Ing Wibisono Darmawan", 863_000, 1438, [863_000]],
          ["HENTO", 1_114_000, 1857, [1_114_000]],
          ["EVI MANURUNG", 482_000, 803, [482_000]],
          ["WELLY ANDRY", 447_500, 746, [447_500]],
        ]
      )

      // CPGT's two investors under one name are two holders.
      assert.lengthOf(
        (yield* heldOn(w, "2026-11-20", "CPGT")).filter(
          ({ name }) => name === "ASIA ARGENTUM ASSETS HONG KONG LIMITED"
        ),
        2
      )
      // ASRI's repeat blocks, one per name variant, until 20 Nov.
      assert.lengthOf(yield* heldOn(w, "2026-11-19", "ASRI"), 5)
      assert.lengthOf(yield* heldOn(w, "2026-11-20", "ASRI"), 3)
      // TRUE's code is a boolean cell.
      assert.isNotEmpty(yield* heldOn(w, "2026-11-20", "TRUE"))
      // An account's origin and domicile, and the shared holder key.
      assert.deepInclude(
        yield* holderNamed(w, "2026-06-11", "BIKE", "PT PENAJAM MAKMUR JAYA"),
        { key: "JAYA MAKMUR PENAJAM" }
      )
      assert.deepInclude(sendi.accounts[0], {
        origin: "local",
        domicile: "INDONESIA",
      })
    })
  )

  it.effect("parses nothing when nothing changed", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archiveAndParse(w, "cron-2026-11-25")
      const result = yield* parse(w, "cron-2026-11-26")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 0 })
    })
  )

  it.effect("replaces a day with its republished version", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archiveAndParse(w, "cron-2026-11-25")
      assert.isNotEmpty(yield* heldOn(w, "2026-11-20", "ENRG"))
      const bike = yield* heldOn(w, "2026-11-20", "BIKE")

      republish(w, "2026-11-20", "republished")
      yield* archive(w, "cron-2026-11-26T13")
      const result = yield* parse(w, "cron-2026-11-26")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 1 })
      // 20 Nov now reads exactly as the republished file: BIKE alone.
      assert.isEmpty(yield* heldOn(w, "2026-11-20", "ENRG"))
      assert.deepStrictEqual(yield* heldOn(w, "2026-11-20", "BIKE"), bike)
      assert.isNotEmpty(yield* heldOn(w, "2026-11-19", "ENRG"))
    })
  )

  it.effect("parses every day again when the parser's version changes", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archiveAndParse(w, "cron-2026-11-25")
      w.holdings.database
        .prepare("UPDATE above_5_day SET parser_version = parser_version - 1")
        .run()
      const result = yield* parse(w, "cron-2026-11-26")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 6 })
    })
  )

  it.effect(
    "fails each day whose single-account counts have no listed shares to resolve against",
    () =>
      Effect.gen(function* () {
        const w = world({ withoutListedShares: true })
        const result = yield* archiveAndParse(w, "cron-2026-11-25")
        assert.deepInclude(result, { outcome: "partial", monthsParsed: 0 })
        assert.lengthOf(result.parseFailures, 6)
        assert.deepInclude(result.parseFailures, {
          date: "2026-11-20",
          message:
            "MAMIP ONGKO DARMAWAN (row 34)'s Saham Gabungan Per Investor (P) is ambiguous, and no parsed investor-type report on or before the day lists the stock's listed shares",
        })
        assert.isEmpty(yield* heldOn(w, "2026-11-20", "BIKE"))
      })
  )

  it.effect("fails when it can't read which days were parsed", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-25T13")
      w.holdings.failBatch = (sql) =>
        sql.some((statement) => statement.includes("FROM above_5_day"))
      const failure = yield* Effect.flip(parse(w, "cron-2026-11-25"))
      assert.strictEqual(failure._tag, "StepFailed")
      assert.deepInclude(runRecord(w, "above-5", "cron-2026-11-25"), {
        outcome: "failed",
        error: failure.message,
        monthsParsed: 0,
      })
    })
  )
})

describe("an above-5% report that doesn't match what's expected", () => {
  const cases: ReadonlyArray<{
    readonly what: string
    readonly fixture: BrokenAbove5Fixture
    readonly reason: string
  }> = [
    {
      what: "a header label it doesn't know",
      fixture: "unknown-header",
      reason: "Header row 2's R isn't Perubahan: Perubahan Saham",
    },
    {
      what: "a title dated another day",
      fixture: "mismatched-date",
      reason: "The title is dated 21 Nov 2026, not 20 Nov 2026",
    },
    {
      what: "a combined count no reading of its accounts sums to",
      fixture: "unresolvable-count",
      reason:
        "BIKE SENDI (row 10)'s Saham Gabungan Per Investor (P) is no sum of its accounts' shares in any reading",
    },
    {
      what: "a Perubahan that isn't the day's change",
      fixture: "wrong-change",
      reason:
        "BIKE SENDI (row 10)'s Perubahan (R) isn't 0, the report date's shares minus the previous day's",
    },
    {
      what: "a percentage below 5",
      fixture: "below-5",
      reason:
        "BIKE SENDI (row 10)'s Persentase Kepemilikan Per Investor (%) (Q) is below 5%: 4.99",
    },
    {
      what: "a missing legend row",
      fixture: "missing-legend",
      reason:
        "The report's legend has no Biru = Ada perubahan persentase kepemilikan tetapi masih tetap diatas 5% dibandingkan hari sebelumnya",
    },
  ]

  for (const { what, fixture, reason } of cases)
    it.effect(
      `fails its day with ${what}, keeps the day's rows, and tries it again next run`,
      () =>
        Effect.gen(function* () {
          const w = world()
          yield* archiveAndParse(w, "cron-2026-11-25")
          const before = yield* heldOn(w, "2026-11-20", "BIKE")
          assert.lengthOf(before, 2)

          republish(w, "2026-11-20", fixture)
          yield* archive(w, "cron-2026-11-26T13")
          const failed = yield* parse(w, "cron-2026-11-26")
          assert.deepInclude(failed, { outcome: "partial", monthsParsed: 0 })
          assert.deepStrictEqual(failed.parseFailures, [
            { date: "2026-11-20", message: reason },
          ])
          assert.deepStrictEqual(
            runRecord(w, "above-5", "cron-2026-11-26"),
            failed
          )
          assert.deepStrictEqual(yield* heldOn(w, "2026-11-20", "BIKE"), before)

          const retried = yield* parse(w, "cron-2026-11-27")
          assert.deepInclude(retried, { outcome: "partial", monthsParsed: 0 })
          assert.deepStrictEqual(retried.parseFailures, failed.parseFailures)
        })
    )
})

describe("the above-5% and above-1% parse runs", () => {
  const parseAbove1 = runParse(above1ParseRuns)

  it.effect(
    "each parse only their own kind's reports, into their own records",
    () =>
      Effect.gen(function* () {
        const w = world({ withAbove1: true })
        republish(w, "2026-11-20", "missing-legend")
        const above5 = yield* archiveAndParse(w, "cron-2026-11-25")
        assert.deepInclude(above5, { outcome: "partial", monthsParsed: 5 })
        const above1 = yield* parseAbove1(w, "cron-2026-11-25")
        assert.deepInclude(above1, { outcome: "complete", monthsParsed: 5 })
        assert.deepStrictEqual(
          runRecord(w, "above-5", "cron-2026-11-25"),
          above5
        )
        assert.deepStrictEqual(
          runRecord(w, "above-1", "cron-2026-11-25"),
          above1
        )
      })
  )
})
