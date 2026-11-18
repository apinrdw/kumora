// The Above-1% parse run: the shareholding archive's holders-above-1%
// reports parsed into ≥1% holders.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"

import { RunId } from "@/server/archive/run"
import { ParseRunResult } from "@/server/holdings/parse-run-result"
import { above1ParseRuns } from "@/server/shareholding/above-1-parse"
import { archiveRun } from "@/server/shareholding/archive-run"
import { investorTypeParseRuns } from "@/server/shareholding/investor-type-parse"

import {
  type Above1Fixture,
  above1Fixture,
  above1Item,
  above1Items,
  type BrokenAbove1Fixture,
  type FakeIdx,
  fakeIdx,
  idxIdUrl,
  investorTypeItems,
} from "./fake-idx.ts"
import { localSteps } from "../archive/local-steps.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"
import {
  type MemoryHoldingsDb,
  memoryHoldingsDb,
} from "../holdings/memory-holdings-db.ts"

interface World {
  readonly idx: FakeIdx
  readonly bucket: MemoryBucket
  readonly holdings: MemoryHoldingsDb
}

// IDX listing the above-1% fixtures' reports, and the investor-type
// fixtures' when `withInvestorType`.
const world = (withInvestorType = false): World => ({
  idx: fakeIdx([
    ...above1Items(),
    ...(withInvestorType ? investorTypeItems() : []),
  ]),
  bucket: memoryBucket(),
  holdings: memoryHoldingsDb(),
})

// Each run an hour after the last, so a version archived later is fetched
// later.
const archive = ({ idx, bucket }: World, id: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      archiveRun(localSteps(Layer.merge(idx.layer, bucket.layer)), {
        id: RunId.make(id),
        trigger: "cron",
        startedAt: new Date("2026-11-14T13:00:00Z"),
      })
    )
  )

const runParse =
  (runs: typeof above1ParseRuns | typeof investorTypeParseRuns) =>
  ({ bucket, holdings }: World, id: string) =>
    TestClock.adjust("1 hour").pipe(
      Effect.andThen(
        runs.run(localSteps(Layer.merge(bucket.layer, holdings.layer)), {
          id: RunId.make(id),
          trigger: "cron",
          startedAt: new Date("2026-11-14T14:00:00Z"),
        })
      )
    )

const parse = runParse(above1ParseRuns)

// IDX replaces a month's report in place with a fixture's bytes.
const republish = (
  { idx }: World,
  dataDate: Above1Fixture,
  fixture: Above1Fixture | BrokenAbove1Fixture
) => {
  idx.files.set(idxIdUrl(above1Item(dataDate).Prospectus), {
    body: above1Fixture(fixture),
    etag: `"etag-${dataDate}:${fixture}"`,
    lastModified: "Sat, 14 Nov 2026 09:00:00 GMT",
  })
}

// A parse run's record as the admin page reads it.
const runRecord = ({ bucket }: World, kind: string, id: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(ParseRunResult))(
    bucket.objects.get(`parse-runs/${kind}/${id}.json`)?.body
  )

const HolderRow = Schema.Struct({
  investor: Schema.String,
  holderKey: Schema.String,
  classification: Schema.NullOr(Schema.String),
  type: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
  nationality: Schema.NullOr(Schema.String),
  domicile: Schema.NullOr(Schema.String),
  controller: Schema.NullOr(Schema.String),
  scripless: Schema.Number,
  scrip: Schema.Number,
  total: Schema.Number,
  hundredths: Schema.Number,
})
type HolderRow = typeof HolderRow.Type

// A stock's rows of `dataDate`, in file order.
// Decision: read from HoldingsDb directly until the stock page reads ≥1%
// holders (apinrdw/kumora#481), the run's only other observer.
const rows = ({ holdings }: World, dataDate: string, code: string) =>
  Schema.decodeUnknownSync(Schema.Array(HolderRow))(
    holdings.database
      .prepare(
        `SELECT investor_name AS investor, holder_key AS holderKey,
           classification, investor_type AS type, origin, nationality,
           domicile, controller, scripless, scrip, total,
           percentage_hundredths AS hundredths
         FROM above_1_holding WHERE data_date = ? AND stock_code = ?
         ORDER BY seq`
      )
      .all(dataDate, code)
  )

// The row of `dataDate`'s stock `code` naming `investor`.
const row = (w: World, dataDate: string, code: string, investor: string) => {
  const found = rows(w, dataDate, code).find(
    (each) => each.investor === investor
  )
  assert.isDefined(found, `${code} ${investor}`)
  return found
}

// A stock's ≥1% holders of `dataDate`: its rows' summed hundredths by
// holder key.
const holders = (w: World, dataDate: string, code: string) => {
  const summed = new Map<string, number>()
  for (const { holderKey, hundredths } of rows(w, dataDate, code))
    summed.set(holderKey, (summed.get(holderKey) ?? 0) + hundredths)
  return summed
}

describe("an above-1% parse run", () => {
  it.effect("parses every archived above-1% month on its first run", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T13")
      const result = yield* parse(w, "cron-2026-11-14")
      assert.deepInclude(result, {
        outcome: "complete",
        monthsParsed: 5,
        parseFailures: [],
      })
      assert.deepStrictEqual(runRecord(w, "above-1", "cron-2026-11-14"), result)

      // Feb 2026: a KSEI type and no classification, a padded `L` local and
      // `A` foreign.
      const permadi: Omit<HolderRow, "holderKey"> = {
        investor: "IR. T. PERMADI RACHMAT",
        classification: null,
        type: "ID",
        origin: "local",
        nationality: "INDONESIAN",
        domicile: "INDONESIA",
        controller: null,
        scripless: 254_992_918,
        scrip: 0,
        total: 254_992_918,
        hundredths: 327,
      }
      assert.deepInclude(
        row(w, "2026-02-27", "AADI", permadi.investor),
        permadi
      )
      assert.deepInclude(
        row(w, "2026-02-27", "AADI", "FTAG INVESTMENT BANK LTD"),
        { origin: "foreign", domicile: "MALAYSIA", type: "IB" }
      )
      // A special scrip account: no type, origin or domicile.
      assert.deepInclude(row(w, "2026-02-27", "BSDE", "PARAGA ARTAMIDA, PT"), {
        type: null,
        origin: null,
        domicile: null,
        scripless: 0,
        scrip: 6_461_120_464,
        hundredths: 3052,
      })
      // TRUE's code is a boolean cell.
      assert.strictEqual(rows(w, "2026-02-27", "TRUE").length, 6)
      // Rows kept in file order, float noise rounded: 1.1500000000000001.
      assert.deepStrictEqual(
        rows(w, "2026-02-27", "AADI").map(({ hundredths }) => hundredths),
        [4110, 1537, 583, 438, 352, 327, 204, 154, 129, 115]
      )
      // BSDE's `PARAGA ARTAMIDA, PT` and `PT PARAGA ARTAMIDA` are one holder;
      // `PT.  PARAGA ARTA MIDA`, spelt with another word, is not. TLKM's BNY
      // Mellon DR is not BNY Mellon.
      const bsde = holders(w, "2026-02-27", "BSDE")
      assert.strictEqual(
        bsde.get(row(w, "2026-02-27", "BSDE", "PT PARAGA ARTAMIDA").holderKey),
        3052 + 680
      )
      assert.strictEqual(
        bsde.get(
          row(w, "2026-02-27", "BSDE", "PT.  PARAGA ARTA MIDA").holderKey
        ),
        293
      )
      const tlkm = holders(w, "2026-02-27", "TLKM")
      assert.strictEqual(tlkm.size, 6)
      assert.strictEqual(
        tlkm.get(
          row(w, "2026-02-27", "TLKM", "THE BANK OF NEW YORK MELLON").holderKey
        ),
        255
      )
      assert.strictEqual(
        tlkm.get(
          row(w, "2026-02-27", "TLKM", "THE BANK OF NEW YORK MELLON DR")
            .holderKey
        ),
        230
      )
      // A title dropped and words reordered: one holder across Feb and Apr.
      assert.strictEqual(
        row(w, "2026-02-27", "RALS", "LO KHENG  HONG. DRS").holderKey,
        row(w, "2026-04-30", "RALS", "DRS LO KHENG HONG").holderKey
      )

      // Apr 2026: a classification and its type, a blank one with neither,
      // the #DIV/0! rows skipped, FLMC's missing scrip cell read as 0, and
      // RALS's duplicate kept as two rows.
      assert.deepInclude(
        row(w, "2026-04-30", "AADI", "FTAG INVESTMENT BANK LTD"),
        {
          classification: "financial_institutional",
          type: "IB",
          origin: "foreign",
        }
      )
      assert.deepInclude(
        row(w, "2026-04-30", "BSDE", "METROPOLITAN TRANSCITIES INDONESIA, PT"),
        { classification: null, type: null, origin: "local" }
      )
      assert.deepInclude(
        row(w, "2026-04-30", "FLMC", "THERESIA INDRA WIRAWAN"),
        { scripless: 308_477_875, scrip: 0, total: 308_477_875 }
      )
      assert.strictEqual(
        row(w, "2026-04-30", "BSDE", "PT PARAGA ARTAMIDA").hundredths,
        4863
      )
      assert.deepStrictEqual(
        rows(w, "2026-04-30", "RALS")
          .filter(({ investor }) => investor === "PT RAMAYANA MAKMURSENTOSA")
          .map(({ classification, total, hundredths }) => ({
            classification,
            total,
            hundredths,
          })),
        [
          { classification: null, total: 3_965_000_000, hundredths: 5588 },
          { classification: "corporate", total: 203_513_800, hundredths: 287 },
        ]
      )
      assert.deepStrictEqual(
        ["AADI", "BSDE", "FLMC", "RALS", "TLKM", "TRUE"].map(
          (code) => rows(w, "2026-04-30", code).length
        ),
        [10, 8, 13, 7, 4, 6]
      )

      // Aug to Sep 2026: AADI's Permadi Rachmat drops his title, one holder.
      assert.strictEqual(
        row(w, "2026-08-31", "AADI", "IR. T. PERMADI RACHMAT").holderKey,
        row(w, "2026-09-30", "AADI", "T PERMADI RACHMAT").holderKey
      )
      assert.deepInclude(
        row(w, "2026-09-30", "AADI", "SARATOGA INVESTAMA SEDAYA TBK"),
        { classification: "private_bank", type: "IB" }
      )

      // Oct 2026: the controller flag, read from the shifted columns.
      assert.deepInclude(
        row(w, "2026-10-30", "AADI", "ADARO STRATEGIC INVESTMENTS"),
        {
          classification: "corporate",
          type: "CP",
          controller: "controller",
          origin: "local",
          domicile: "INDONESIA",
          scripless: 3_200_142_830,
          scrip: 0,
          total: 3_200_142_830,
          hundredths: 4110,
        }
      )
      assert.deepInclude(row(w, "2026-10-30", "AADI", "T PERMADI RACHMAT"), {
        controller: "affiliate",
        nationality: "INDONESIAN",
      })
      assert.deepInclude(
        row(w, "2026-10-30", "AADI", "FTAG INVESTMENT BANK LTD"),
        { controller: null, hundredths: 114 }
      )
    })
  )

  it.effect("parses nothing when nothing changed", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T13")
      yield* parse(w, "cron-2026-11-14")
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 0 })
    })
  )

  it.effect("replaces a month with its republished version", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T06")
      yield* parse(w, "cron-2026-11-14")

      republish(w, "2026-10-30", "2026-02-27")
      yield* archive(w, "cron-2026-11-14T13")
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 1 })
      // October now reads exactly as the republished file: no old row left.
      for (const code of ["AADI", "BSDE", "FLMC", "RALS", "TLKM", "TRUE"])
        assert.deepStrictEqual(
          rows(w, "2026-10-30", code),
          rows(w, "2026-02-27", code)
        )
    })
  )

  it.effect("parses every month again when the parser's version changes", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T06")
      yield* parse(w, "cron-2026-11-14")
      w.holdings.database
        .prepare("UPDATE above_1_month SET parser_version = parser_version - 1")
        .run()
      const result = yield* parse(w, "cron-2026-11-15")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 5 })
    })
  )

  it.effect("fails when it can't read which months were parsed", () =>
    Effect.gen(function* () {
      const w = world()
      yield* archive(w, "cron-2026-11-14T06")
      w.holdings.failBatch = (sql) =>
        sql.some((statement) => statement.includes("FROM above_1_month"))
      const failure = yield* Effect.flip(parse(w, "cron-2026-11-14"))
      assert.strictEqual(failure._tag, "StepFailed")
      assert.deepInclude(runRecord(w, "above-1", "cron-2026-11-14"), {
        outcome: "failed",
        error: failure.message,
        monthsParsed: 0,
      })
    })
  )
})

describe("an above-1% report that doesn't match what's expected", () => {
  const cases: ReadonlyArray<{
    readonly what: string
    readonly fixture: BrokenAbove1Fixture
    readonly reason: string
  }> = [
    {
      what: "a header that matches no layout",
      fixture: "unknown-header",
      reason: "Header row 5's M isn't PERCENTAGE: PERCENT",
    },
    {
      what: "a share count that isn't a number",
      fixture: "text-shares",
      reason:
        "AADI (row 6)'s HOLDINGS_SCRIPLESS isn't a share count: 119.887.170",
    },
    {
      what: "an error in a cell it reads",
      fixture: "error-shares",
      reason: "AADI (row 6)'s HOLDINGS_SCRIPLESS holds the error #VALUE!",
    },
    {
      what: "a classification outside the 39",
      fixture: "unknown-classification",
      reason: "AADI (row 6)'s INVESTOR_CLASSIFICATION is unknown: Corporates",
    },
    {
      what: "no holder rows",
      fixture: "empty",
      reason: "The report has no holders",
    },
  ]

  for (const { what, fixture, reason } of cases)
    it.effect(
      `fails its month with ${what}, keeps the month's rows, and tries it again next run`,
      () =>
        Effect.gen(function* () {
          const w = world()
          yield* archive(w, "cron-2026-11-14T06")
          yield* parse(w, "cron-2026-11-14")
          const before = rows(w, "2026-10-30", "AADI")
          assert.lengthOf(before, 10)

          republish(w, "2026-10-30", fixture)
          yield* archive(w, "cron-2026-11-14T13")
          const failed = yield* parse(w, "cron-2026-11-15")
          assert.deepInclude(failed, { outcome: "partial", monthsParsed: 0 })
          assert.deepStrictEqual(failed.parseFailures, [
            { date: "2026-10-30", message: reason },
          ])
          assert.deepStrictEqual(
            runRecord(w, "above-1", "cron-2026-11-15"),
            failed
          )
          assert.deepStrictEqual(rows(w, "2026-10-30", "AADI"), before)

          const retried = yield* parse(w, "cron-2026-11-16")
          assert.deepInclude(retried, { outcome: "partial", monthsParsed: 0 })
          assert.deepStrictEqual(retried.parseFailures, failed.parseFailures)
        })
    )
})

describe("the above-1% and investor-type parse runs", () => {
  const parseInvestorType = runParse(investorTypeParseRuns)

  it.effect(
    "each parse only their own kind's months, into their own records",
    () =>
      Effect.gen(function* () {
        const w = world(true)
        republish(w, "2026-10-30", "empty")
        yield* archive(w, "cron-2026-11-14T13")

        const above1 = yield* parse(w, "cron-2026-11-14")
        assert.deepInclude(above1, { outcome: "partial", monthsParsed: 4 })
        const investorType = yield* parseInvestorType(w, "cron-2026-11-14")
        assert.deepInclude(investorType, {
          outcome: "complete",
          monthsParsed: 3,
        })
        assert.deepStrictEqual(
          runRecord(w, "above-1", "cron-2026-11-14"),
          above1
        )
        assert.deepStrictEqual(
          runRecord(w, "investor-type", "cron-2026-11-14"),
          investorType
        )
      })
  )
})
