// The stock page's read model, read after a real classification parse run
// parsed the classification fixtures (Mar, May, Sep and Oct 2026) and a real
// investor-type parse run the investor-type fixtures (Nov 2025, Apr and Oct
// 2026), both archived by a real archive run, and a real KSEI parse run
// parsed the KSEI fixtures (May, Aug, Sep and Oct 2026).
import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect, Layer } from "effect"

import { KSEI_TYPES } from "@/domain/holdings"
import { scrip } from "@/lib/stock-composition"
import { RunId } from "@/server/archive/run"
import { parseClassificationMonth } from "@/server/holdings/classification"
import {
  type CompositionMonth,
  stockList,
  stockPage,
} from "@/server/holdings/stock-page"
import { kseiArchiveRun } from "@/server/ksei/archive-run"
import { kseiParseRuns } from "@/server/ksei/parse-runs"
import { archiveRun } from "@/server/shareholding/archive-run"
import { classificationParseRuns } from "@/server/shareholding/classification-parse"
import { investorTypeParseRuns } from "@/server/shareholding/investor-type-parse"

import {
  classificationIdx,
  fakeIdx,
  investorTypeItems,
} from "../shareholding/fake-idx.ts"
import { localSteps } from "../archive/local-steps.ts"
import { holdingsKsei } from "../ksei/fake-ksei.ts"
import { memoryBucket } from "../archive/memory-bucket.ts"
import { memoryHoldingsDb } from "./memory-holdings-db.ts"
import {
  columnLetters,
  SPLIT_HEADER_ROW,
  SPLIT_LABELS,
  workbook,
} from "./workbook.ts"

const run = (id: string, startedAt: string) => ({
  id: RunId.make(id),
  trigger: "cron" as const,
  startedAt: new Date(startedAt),
})

const parsed = Effect.gen(function* () {
  const holdings = memoryHoldingsDb()
  const kseiBucket = memoryBucket()
  yield* kseiArchiveRun(
    localSteps(Layer.merge(holdingsKsei().layer, kseiBucket.layer)),
    run("cron-2026-11-14T03", "2026-11-14T03:00:00Z")
  )
  yield* kseiParseRuns.run(
    localSteps(Layer.merge(kseiBucket.layer, holdings.layer)),
    run("cron-2026-11-14T04", "2026-11-14T04:00:00Z")
  )
  const bucket = memoryBucket()
  yield* archiveRun(
    localSteps(
      Layer.merge(
        fakeIdx([...classificationIdx().listing, ...investorTypeItems()]).layer,
        bucket.layer
      )
    ),
    run("cron-2026-11-14T13", "2026-11-14T13:00:00Z")
  )
  for (const runs of [classificationParseRuns, investorTypeParseRuns])
    yield* runs.run(
      localSteps(Layer.merge(bucket.layer, holdings.layer)),
      run("cron-2026-11-14", "2026-11-14T14:00:00Z")
    )
  return holdings.layer
})

const read = (code: string, month?: string) =>
  Effect.gen(function* () {
    const layer = yield* parsed
    return yield* stockPage(StockCode.make(code), month).pipe(
      Effect.provide(layer)
    )
  })

const sum = (values: ReadonlyArray<number | undefined>) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0)

const typeShares = (month: CompositionMonth | undefined) =>
  Object.fromEntries(
    (month?.types ?? []).map(({ type, combined }) => [type, combined])
  )

describe("the stock page read", () => {
  it.effect(
    "opens a stock's newest month, compared with the month before",
    () =>
      Effect.gen(function* () {
        const page = yield* read("BBCA")
        assert.strictEqual(page.issuerName, "BANK CENTRAL ASIA Tbk")
        assert.deepStrictEqual(page.months, [
          { dataDate: "2026-03-31", held: true },
          { dataDate: "2026-05-29", held: true },
          { dataDate: "2026-09-30", held: true },
          { dataDate: "2026-10-30", held: true },
        ])
        const { month, previous } = page.composition ?? {}
        assert.strictEqual(month?.dataDate, "2026-10-30")
        assert.strictEqual(month?.totalScripless, 52_453_691_120)
        assert.strictEqual(previous?.dataDate, "2026-09-30")
        // Every KSEI investor type, in order, built from its classifications.
        assert.deepStrictEqual(
          month?.types.map(({ type }) => type),
          ["ID", "CP", "MF", "IB", "IS", "SC", "PF", "FD", "OT"]
        )
        const ib = month?.types.find(({ type }) => type === "IB")
        assert.deepInclude(
          ib?.classifications.find(
            ({ classification }) => classification === "bank"
          ),
          {
            combined: 1_515_561_935,
            local: 513_627_500,
            foreign: 1_001_934_435,
          }
        )
        assert.strictEqual(
          typeShares(month).ID,
          month?.types
            .find(({ type }) => type === "ID")
            ?.classifications.reduce((total, each) => total + each.combined, 0)
        )
      })
  )

  it.effect("sums the 9-type rows to total scripless, in each origin", () =>
    Effect.gen(function* () {
      for (const code of ["AADI", "ACRO", "BBCA", "WBSA"]) {
        const { month } = (yield* read(code)).composition ?? {}
        const types = month?.types ?? []
        assert.strictEqual(
          sum(types.map(({ combined }) => combined)),
          month?.totalScripless,
          code
        )
        assert.strictEqual(
          sum(types.map(({ local }) => local)) +
            sum(types.map(({ foreign }) => foreign)),
          month?.totalScripless,
          code
        )
      }
    })
  )

  it.effect("reads an unsplit month's local and foreign as absent", () =>
    Effect.gen(function* () {
      const { month, previous } =
        (yield* read("BBCA", "2026-05")).composition ?? {}
      assert.strictEqual(month?.dataDate, "2026-05-29")
      assert.isFalse(month?.split)
      assert.isTrue(
        month?.types.every(
          ({ local, foreign, classifications }) =>
            local === undefined &&
            foreign === undefined &&
            classifications.every(
              (each) => each.local === undefined && each.foreign === undefined
            )
        )
      )
      assert.strictEqual(previous?.dataDate, "2026-03-31")
      // A split month reads local and foreign, zero included.
      const { month: october } =
        (yield* read("BBCA", "2026-10")).composition ?? {}
      assert.isTrue(october?.split)
      assert.isTrue(october?.types.every(({ local }) => local !== undefined))
    })
  )

  it.effect(
    "reads a split month's local and foreign as 0 for a stock holding no scripless shares",
    () =>
      Effect.gen(function* () {
        // The report's one stock, every column empty and its total 0: the
        // parse stores no holding for it.
        const total = columnLetters(SPLIT_LABELS.length - 1)
        const bytes = yield* workbook(
          `${SPLIT_HEADER_ROW}<row r="2"><c r="B2" t="str"><v>ZERO</v></c><c r="C2" t="str"><v>ZERO Tbk</v></c><c r="${total}2"><v>0</v></c></row>`,
          SPLIT_LABELS
        )
        const holdings = memoryHoldingsDb()
        yield* parseClassificationMonth(
          "2026-10-30",
          "sha",
          bytes,
          "2026-11-15T00:00:00Z"
        ).pipe(Effect.provide(holdings.layer))
        const { month } =
          (yield* stockPage(StockCode.make("ZERO"), undefined).pipe(
            Effect.provide(holdings.layer)
          )).composition ?? {}
        assert.strictEqual(month?.totalScripless, 0)
        assert.isTrue(month?.split)
        assert.isTrue(
          month?.types.every(
            ({ local, foreign }) => local === 0 && foreign === 0
          )
        )
      })
  )

  it.effect("has no previous month in the stock's first month", () =>
    Effect.gen(function* () {
      const march = (yield* read("BBCA", "2026-03")).composition
      assert.strictEqual(march?.month.dataDate, "2026-03-31")
      assert.isUndefined(march?.previous)
      // WBSA listed after March: May is its first month in the report.
      const may = (yield* read("WBSA", "2026-05")).composition
      assert.strictEqual(may?.month.dataDate, "2026-05-29")
      assert.isUndefined(may?.previous)
    })
  )

  it.effect("marks a month without the stock, and falls back past it", () =>
    Effect.gen(function* () {
      const page = yield* read("WBSA", "2026-03")
      assert.strictEqual(page.issuerName, "BSA LOGISTICS INDONESIA Tbk")
      assert.deepStrictEqual(
        page.months.map(({ held }) => held),
        [false, true, true, true]
      )
      // March has no row for WBSA: the newest month opens instead.
      assert.strictEqual(page.composition?.month.dataDate, "2026-10-30")
      // So do a month not archived and one that doesn't parse.
      for (const month of ["2026-04", "May 2026"])
        assert.strictEqual(
          (yield* read("WBSA", month)).composition?.month.dataDate,
          "2026-10-30"
        )
    })
  )

  it.effect("reads listed shares from KSEI's report of the same date", () =>
    Effect.gen(function* () {
      const october = (yield* read("BBCA")).composition
      assert.strictEqual(october?.month.listedShares, 123_275_050_000)
      assert.strictEqual(october?.previous?.listedShares, 123_275_050_000)
      // KSEI's May Securities holdings report is dated 2026-05-29, as IDX's
      // classification report is; KSEI has no March report, and its August
      // report has no classification month.
      const may = (yield* read("WBSA", "2026-05")).composition
      assert.strictEqual(may?.month.listedShares, 8_675_000_000)
      const march = (yield* read("BBCA", "2026-03")).composition
      assert.isUndefined(march?.month.listedShares)
    })
  )

  it.effect("shows BBCA's Oct 2026 shares as 57.45% scrip", () =>
    Effect.gen(function* () {
      const { month, previous } = (yield* read("BBCA")).composition ?? {}
      assert.strictEqual(month?.dataDate, "2026-10-30")
      assert.isDefined(month)
      assert.isDefined(previous)
      const october = yield* scrip(month)
      assert.strictEqual(
        october._tag === "Share" ? october.split.left.toFixed(4) : october._tag,
        "0.5745"
      )
      assert.strictEqual((yield* scrip(previous))._tag, "Share")
      // No KSEI report of March's date: scrip is unavailable, never a guess.
      const { month: march } =
        (yield* read("BBCA", "2026-03")).composition ?? {}
      assert.isDefined(march)
      assert.strictEqual((yield* scrip(march))._tag, "NoListedShares")
    })
  )

  it.effect("reads a stock only KSEI has with no composition", () =>
    Effect.gen(function* () {
      // APOL is unpriced: in every KSEI report, in no classification report.
      const page = yield* read("APOL")
      assert.isUndefined(page.composition)
      assert.isUndefined(page.issuerName)
      assert.isTrue(page.months.every(({ held }) => !held))
      assert.isTrue(page.inKsei)
      assert.isTrue((yield* read("BBCA")).inKsei)
    })
  )

  it.effect("reads a stock neither source has as in neither", () =>
    Effect.gen(function* () {
      const page = yield* read("ZZZZ")
      assert.isUndefined(page.composition)
      assert.isTrue(page.months.every(({ held }) => !held))
      assert.isFalse(page.inKsei)
    })
  )

  it.effect("lists the stocks of either source's newest month", () =>
    Effect.gen(function* () {
      const layer = yield* parsed
      assert.deepStrictEqual(yield* stockList.pipe(Effect.provide(layer)), [
        { code: "AADI", issuerName: "ADARO ANDALAN INDONESIA Tbk" },
        { code: "ACRO", issuerName: "SAMCRO HYOSUNG ADILESTARI Tbk" },
        // Only KSEI has APOL, and KSEI's report names no issuer.
        { code: "APOL", issuerName: undefined },
        { code: "BBCA", issuerName: "BANK CENTRAL ASIA Tbk" },
        // Only the investor-type report has TRUE, and it names no issuer.
        { code: "TRUE", issuerName: undefined },
        { code: "WBSA", issuerName: "BSA LOGISTICS INDONESIA Tbk" },
      ])
    })
  )
})

const NO_HOLDING = { under5: 0, atLeast5: 0 }

describe("the stock page's Holder size read", () => {
  it.effect("reads every investor-type month, oldest first", () =>
    Effect.gen(function* () {
      const { holderSize } = yield* read("AADI")
      assert.deepStrictEqual(
        holderSize.map(({ dataDate, split }) => ({ dataDate, split })),
        [
          { dataDate: "2025-11-28", split: false },
          { dataDate: "2026-04-30", split: true },
          { dataDate: "2026-10-30", split: true },
        ]
      )
      // Nov 2025 doesn't split: local and foreign are absent, not 0.
      assert.deepStrictEqual(holderSize[0]?.holding, {
        sharesOutstanding: 7_786_891_760,
        totalScripless: 7_786_891_760,
        combined: {
          ID: { under5: 1_412_471_655, atLeast5: 454_011_607 },
          CP: { under5: 701_501_094, atLeast5: 4_397_166_772 },
          MF: { under5: 331_782_018, atLeast5: 0 },
          IB: { under5: 196_305_490, atLeast5: 0 },
          IS: { under5: 81_345_483, atLeast5: 0 },
          SC: { under5: 66_776_429, atLeast5: 0 },
          PF: { under5: 73_223_227, atLeast5: 0 },
          FD: { under5: 4_069_998, atLeast5: 0 },
          OT: { under5: 68_237_987, atLeast5: 0 },
        },
      })
    })
  )

  it.effect("reads a split month's combined as local plus foreign", () =>
    Effect.gen(function* () {
      const october = (yield* read("BBCA")).holderSize.at(-1)?.holding
      assert.strictEqual(october?.sharesOutstanding, 123_275_050_000)
      assert.strictEqual(october?.totalScripless, 52_453_691_120)
      const { combined, local, foreign } = october ?? {}
      assert.isDefined(combined)
      assert.isDefined(local)
      assert.isDefined(foreign)
      for (const type of KSEI_TYPES)
        assert.deepStrictEqual(combined[type], {
          under5: local[type].under5 + foreign[type].under5,
          atLeast5: local[type].atLeast5 + foreign[type].atLeast5,
        })
      assert.strictEqual(
        sum(
          KSEI_TYPES.flatMap((type) => [
            combined[type].under5,
            combined[type].atLeast5,
          ])
        ),
        52_453_691_120
      )
    })
  )

  it.effect("reads a month without the stock as a gap", () =>
    Effect.gen(function* () {
      // WBSA lists from April 2026.
      const { holderSize } = yield* read("WBSA")
      assert.deepStrictEqual(
        holderSize.map(({ holding }) => holding !== undefined),
        [false, true, true]
      )
      // A type with no holding holds 0 in both.
      assert.deepStrictEqual(holderSize[1]?.holding?.local?.FD, NO_HOLDING)
    })
  )

  it.effect("opens a stock only the investor-type report has", () =>
    Effect.gen(function* () {
      // TRUE is in no classification or KSEI report, and its Apr 2026 code
      // is a boolean cell.
      const page = yield* read("TRUE")
      assert.isUndefined(page.composition)
      assert.isFalse(page.inKsei)
      assert.deepStrictEqual(page.holderSize[1]?.holding?.local?.CP, {
        under5: 10_903_700,
        atLeast5: 4_401_787_656,
      })
    })
  )

  it.effect("reads a stock no investor-type report has as all gaps", () =>
    Effect.gen(function* () {
      const { holderSize } = yield* read("ACRO")
      assert.strictEqual(holderSize.length, 3)
      assert.isTrue(holderSize.every(({ holding }) => holding === undefined))
    })
  )
})
