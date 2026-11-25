// The Above-5% parse run: the shareholding archive's daily holders-above-5%
// reports parsed into above-5% holders.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"

import { RunId } from "@/server/archive/run"
import { ParseRunResult } from "@/server/holdings/parse-run-result"
import { above1ParseRuns } from "@/server/shareholding/above-1-parse"
import { above5ParseRuns } from "@/server/shareholding/above-5-parse"
import { archiveRun } from "@/server/shareholding/archive-run"
import { investorTypeParseRuns } from "@/server/shareholding/investor-type-parse"

import {
  type Above5Fixture,
  above1Items,
  above5Fixture,
  above5Item,
  above5Items,
  type BrokenAbove5Fixture,
  type FakeIdx,
  fakeIdx,
  idxIdUrl,
  listedSharesItems,
  type RepublishedAbove5Fixture,
} from "./fake-idx.ts"
import { localSteps } from "../archive/local-steps.ts"
import {
  archiveDbOf,
  shareholdingParse,
  type ShareholdingParseKind,
  storedRun,
} from "../archive/runs.ts"
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

// IDX listing the above-5% fixtures' reports, with the investor-type reports
// their listed shares come from unless `withoutListedShares`, and the
// above-1% fixtures' when `withAbove1`.
const world = ({
  withoutListedShares = false,
  withAbove1 = false,
} = {}): World => ({
  idx: fakeIdx([
    ...above5Items(),
    ...(withoutListedShares ? [] : listedSharesItems()),
    ...(withAbove1 ? above1Items() : []),
  ]),
  bucket: memoryBucket(),
  holdings: memoryHoldingsDb(),
})

// Each run an hour after the last, so a version archived later is fetched
// later.
const archive = ({ idx, bucket }: World, id: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      archiveRun(
        localSteps(
          Layer.mergeAll(idx.layer, bucket.layer, archiveDbOf(bucket).layer)
        ),
        {
          id: RunId.make(id),
          trigger: "cron",
          startedAt: new Date("2026-11-25T13:00:00Z"),
        }
      )
    )
  )

const runParse =
  (
    runs:
      | typeof above5ParseRuns
      | typeof above1ParseRuns
      | typeof investorTypeParseRuns
  ) =>
  ({ bucket, holdings }: World, id: string) =>
    TestClock.adjust("1 hour").pipe(
      Effect.andThen(
        runs.run(
          localSteps(
            Layer.mergeAll(
              bucket.layer,
              holdings.layer,
              archiveDbOf(bucket).layer
            )
          ),
          {
            id: RunId.make(id),
            trigger: "cron",
            startedAt: new Date("2026-11-25T14:00:00Z"),
          }
        )
      )
    )

const parse = runParse(above5ParseRuns)
const parseInvestorType = runParse(investorTypeParseRuns)

// Archives every listed report, parses the investor-type ones for their
// listed shares, then runs the above-5% parse run.
const archiveAndParse = Effect.fnUntraced(function* (w: World, id: string) {
  yield* archive(w, `${id}T13`)
  yield* parseInvestorType(w, id)
  return yield* parse(w, id)
})

// IDX replaces a day's report in place with a fixture's bytes.
const republish = (
  { idx }: World,
  dataDate: Above5Fixture,
  fixture: BrokenAbove5Fixture | RepublishedAbove5Fixture
) => {
  idx.files.set(idxIdUrl(above5Item(dataDate).Prospectus), {
    body: above5Fixture(fixture),
    etag: `"etag-${dataDate}:${fixture}"`,
    lastModified: "Wed, 25 Nov 2026 09:00:00 GMT",
  })
}

// A parse run's record as the admin page reads it.
const runRecord = (
  { bucket }: World,
  kind: ShareholdingParseKind,
  id: string
) =>
  Schema.decodeUnknownSync(ParseRunResult)(
    storedRun(archiveDbOf(bucket), shareholdingParse(kind), id)
  )

// A stock's stored above-5% holders of `dataDate`, in block order, each with
// its accounts' shares.
// No page reads above-5% holders yet; the stock page's Daily holders read
// (apinrdw/kumora#676) replaces this.
const StoredAccounts = Schema.Array(
  Schema.Struct({
    no: Schema.Number,
    custodian: Schema.String,
    account_name: Schema.String,
    origin: Schema.String,
    domicile: Schema.NullOr(Schema.String),
    scripless: Schema.Number,
  })
)
const StoredHolders = Schema.Array(
  Schema.Struct({
    no: Schema.Number,
    issuer_name: Schema.String,
    holder_name: Schema.String,
    holder_key: Schema.String,
    scripless: Schema.Number,
    percentage_hundredths: Schema.Number,
  })
)

const storedDay = ({ holdings }: World, dataDate: string, code: string) => {
  const accounts = Schema.decodeUnknownSync(StoredAccounts)(
    holdings.database
      .prepare(
        "SELECT no, custodian, account_name, origin, domicile, scripless FROM above_5_account WHERE data_date = ? AND stock_code = ? ORDER BY no, ordinal"
      )
      .all(dataDate, code)
  )
  const holders = Schema.decodeUnknownSync(StoredHolders)(
    holdings.database
      .prepare(
        "SELECT no, issuer_name, holder_name, holder_key, scripless, percentage_hundredths FROM above_5_holder WHERE data_date = ? AND stock_code = ? ORDER BY no"
      )
      .all(dataDate, code)
  )
  return holders.map(({ no, ...holder }) => ({
    ...holder,
    accounts: accounts
      .filter((account) => account.no === no)
      .map(({ no: _, ...account }) => account),
  }))
}

const holderNamed = (
  w: World,
  dataDate: string,
  code: string,
  name: string
) => {
  const holder = storedDay(w, dataDate, code).find(
    ({ holder_name }) => holder_name === name
  )
  assert.isDefined(holder, `${dataDate} ${code} ${name}`)
  return holder
}

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
      const sendi = holderNamed(w, "2026-06-11", "BIKE", "SENDI")
      assert.deepInclude(sendi, {
        issuer_name: "SEPEDA BERSAMA INDONESIA Tbk, PT",
        scripless: 75_962_140,
        percentage_hundredths: 587,
      })
      assert.deepStrictEqual(
        sendi.accounts.map(({ scripless }) => scripless),
        [75_176_540, 20_600, 765_000]
      )
      // 19 Nov's fourth account, `57.4`, is 57,400.
      assert.deepStrictEqual(
        holderNamed(w, "2026-11-19", "BIKE", "SENDI").accounts.map(
          ({ scripless }) => scripless
        ),
        [1_015_200, 57_400, 75_176_540, 20_600]
      )

      // MAMIP's single accounts, against its 6,000,000 listed shares:
      // `500` at 8.33% is 500,000 and `863` at 14.38% is 863,000; `447.5`
      // is 447,500.
      assert.deepStrictEqual(
        storedDay(w, "2026-06-11", "MAMIP").map(
          ({ holder_name, scripless, percentage_hundredths, accounts }) => [
            holder_name,
            scripless,
            percentage_hundredths,
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
        storedDay(w, "2026-11-20", "CPGT").filter(
          ({ holder_name }) =>
            holder_name === "ASIA ARGENTUM ASSETS HONG KONG LIMITED"
        ),
        2
      )
      // ASRI's repeat blocks, one per name variant, until 20 Nov.
      assert.lengthOf(storedDay(w, "2026-11-19", "ASRI"), 5)
      assert.lengthOf(storedDay(w, "2026-11-20", "ASRI"), 3)
      // TRUE's code is a boolean cell.
      assert.isNotEmpty(storedDay(w, "2026-11-20", "TRUE"))
      // An account's origin and domicile, and the shared holder key.
      assert.deepInclude(
        holderNamed(w, "2026-06-11", "BIKE", "PT PENAJAM MAKMUR JAYA"),
        { holder_key: "JAYA MAKMUR PENAJAM" }
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
      assert.isNotEmpty(storedDay(w, "2026-11-20", "ENRG"))
      const bike = storedDay(w, "2026-11-20", "BIKE")

      republish(w, "2026-11-20", "republished")
      yield* archive(w, "cron-2026-11-26T13")
      const result = yield* parse(w, "cron-2026-11-26")
      assert.deepInclude(result, { outcome: "complete", monthsParsed: 1 })
      // 20 Nov now reads exactly as the republished file: BIKE alone.
      assert.isEmpty(storedDay(w, "2026-11-20", "ENRG"))
      assert.deepStrictEqual(storedDay(w, "2026-11-20", "BIKE"), bike)
      assert.isNotEmpty(storedDay(w, "2026-11-19", "ENRG"))
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
        assert.isEmpty(storedDay(w, "2026-11-20", "BIKE"))
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
          const before = storedDay(w, "2026-11-20", "BIKE")
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
          assert.deepStrictEqual(storedDay(w, "2026-11-20", "BIKE"), before)

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
