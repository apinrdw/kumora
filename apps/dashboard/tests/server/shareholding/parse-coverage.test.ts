// The Classification and Investor-type parse runs' parse coverage: each
// archived month of the kind's reports and its state, from the shareholding
// archive, the kind's parsed holdings and the kind's last finished parse run.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { RunId } from "@/server/archive/run"
import { archiveRun } from "@/server/shareholding/archive-run"
import { classificationParseRuns } from "@/server/shareholding/classification-parse"
import { investorTypeParseRuns } from "@/server/shareholding/investor-type-parse"

import {
  classificationFixture,
  classificationItem,
  type ClassificationFixture,
  type FakeIdx,
  fakeIdx,
  idxIdUrl,
  investorTypeFixture,
  investorTypeItem,
  investorTypeItems,
  type ListingItem,
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

const CLASSIFICATION_DATES: ReadonlyArray<ClassificationFixture> = [
  "2026-03-31",
  "2026-05-29",
  "2026-09-30",
  "2026-10-30",
]

// IDX listing every classification and investor-type fixture's report.
const world = (): World => ({
  idx: fakeIdx([
    ...CLASSIFICATION_DATES.map(classificationItem),
    ...investorTypeItems(),
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

// IDX replaces a listed report in place with other bytes.
const republish = (
  { idx }: World,
  item: ListingItem,
  body: Uint8Array<ArrayBuffer>
) =>
  idx.files.set(idxIdUrl(item.Prospectus), {
    body,
    etag: `"etag-${idx.files.size}:${body.length}"`,
    lastModified: "Sat, 14 Nov 2026 09:00:00 GMT",
  })

// What differs between the two kinds; every date is one of its fixtures'.
interface Kind {
  readonly name: string
  // reports/<kind>/, as keys.ts lays out.
  readonly prefix: string
  readonly runs: typeof classificationParseRuns | typeof investorTypeParseRuns
  readonly monthTable: string
  readonly dates: ReadonlyArray<string>
  // Its October report republished: a valid newer version, or a broken one.
  readonly newerOctober: (w: World) => void
  readonly brokenOctober: (w: World) => void
}

const CLASSIFICATION: Kind = {
  name: "classification",
  prefix: "reports/investor-classification/",
  runs: classificationParseRuns,
  monthTable: "classification_month",
  dates: CLASSIFICATION_DATES,
  newerOctober: (w) =>
    republish(
      w,
      classificationItem("2026-10-30"),
      classificationFixture("2026-09-30")
    ),
  brokenOctober: (w) =>
    republish(
      w,
      classificationItem("2026-10-30"),
      classificationFixture("unsummed")
    ),
}

const INVESTOR_TYPE: Kind = {
  name: "investor-type",
  prefix: "reports/investor-type/",
  runs: investorTypeParseRuns,
  monthTable: "investor_type_month",
  dates: ["2025-11-28", "2026-04-30", "2026-10-30"],
  newerOctober: (w) =>
    republish(
      w,
      investorTypeItem("2026-10-30"),
      investorTypeFixture("2026-04-30")
    ),
  brokenOctober: (w) =>
    republish(
      w,
      investorTypeItem("2026-10-30"),
      investorTypeFixture("unknown-header")
    ),
}

const parse = ({ bucket, holdings }: World, { runs }: Kind, id: string) =>
  TestClock.adjust("1 hour").pipe(
    Effect.andThen(
      runs.run(localSteps(Layer.merge(bucket.layer, holdings.layer)), {
        id: RunId.make(id),
        trigger: "cron",
        startedAt: new Date("2026-11-14T14:00:00Z"),
      })
    )
  )

// The kind's coverage as each shown cell's state by its date.
const coverage = ({ bucket, holdings }: World, { runs }: Kind) =>
  runs.parseCoverage.pipe(
    Effect.provide(Layer.merge(bucket.layer, holdings.layer)),
    Effect.map((years) =>
      Object.fromEntries(
        years.flatMap(({ months }) =>
          months.flatMap((month) =>
            month === null ? [] : [[month.date, month.state]]
          )
        )
      )
    )
  )

// Every date of `kind` in `state`, but October 30 in `october`.
const states = (kind: Kind, state: string, october = state) =>
  Object.fromEntries(
    kind.dates.map((date) => [date, date === "2026-10-30" ? october : state])
  )

for (const kind of [CLASSIFICATION, INVESTOR_TYPE])
  describe(`the ${kind.name} parse coverage`, () => {
    it.effect("shows each archived month not parsed yet", () =>
      Effect.gen(function* () {
        const w = world()
        yield* archive(w, "cron-2026-11-14T06")
        assert.deepStrictEqual(
          yield* coverage(w, kind),
          states(kind, "not-parsed")
        )
      })
    )

    it.effect("shows each month parsed once its parse run parsed it", () =>
      Effect.gen(function* () {
        const w = world()
        yield* archive(w, "cron-2026-11-14T06")
        yield* parse(w, kind, "cron-2026-11-14")
        assert.deepStrictEqual(yield* coverage(w, kind), states(kind, "parsed"))
      })
    )

    it.effect("shows a month stale once a newer version is archived", () =>
      Effect.gen(function* () {
        const w = world()
        yield* archive(w, "cron-2026-11-14T06")
        yield* parse(w, kind, "cron-2026-11-14")
        kind.newerOctober(w)
        yield* archive(w, "cron-2026-11-14T13")
        assert.deepStrictEqual(
          yield* coverage(w, kind),
          states(kind, "parsed", "stale")
        )
      })
    )

    it.effect("shows a month stale when an older parser parsed it", () =>
      Effect.gen(function* () {
        const w = world()
        yield* archive(w, "cron-2026-11-14T06")
        yield* parse(w, kind, "cron-2026-11-14")
        w.holdings.database
          .prepare(
            `UPDATE ${kind.monthTable} SET parser_version = parser_version - 1 WHERE data_date = ?`
          )
          .run("2026-10-30")
        assert.deepStrictEqual(
          yield* coverage(w, kind),
          states(kind, "parsed", "stale")
        )
      })
    )

    it.effect(
      "shows a month failed though it keeps older parsed holdings",
      () =>
        Effect.gen(function* () {
          const w = world()
          yield* archive(w, "cron-2026-11-14T06")
          yield* parse(w, kind, "cron-2026-11-14")
          kind.brokenOctober(w)
          yield* archive(w, "cron-2026-11-14T13")
          yield* parse(w, kind, "cron-2026-11-15")
          assert.deepStrictEqual(
            yield* coverage(w, kind),
            states(kind, "parsed", "failed")
          )
        })
    )

    it.effect("shows a month failed that has no parsed holdings", () =>
      Effect.gen(function* () {
        const w = world()
        kind.brokenOctober(w)
        yield* archive(w, "cron-2026-11-14T06")
        yield* parse(w, kind, "cron-2026-11-14")
        assert.deepStrictEqual(
          yield* coverage(w, kind),
          states(kind, "parsed", "failed")
        )
      })
    )

    it.effect("shows a month's later date when two share its month", () =>
      Effect.gen(function* () {
        const w = world()
        yield* archive(w, "cron-2026-11-14T06")
        yield* parse(w, kind, "cron-2026-11-14")
        // A record of a report dated 2026-10-31, never parsed.
        w.bucket.objects.set(
          `${kind.prefix}2026-10-31/${"a".repeat(64)}.2026-11-14T150000.000Z.0123456789abcdef.json`,
          { body: "{}", contentType: "application/json", customMetadata: {} }
        )
        const { "2026-10-30": _october, ...earlier } = states(kind, "parsed")
        assert.deepStrictEqual(yield* coverage(w, kind), {
          ...earlier,
          "2026-10-31": "not-parsed",
        })
      })
    )
  })

describe("the two kinds' parse coverage", () => {
  it.effect("marks a month failed only in the kind whose run failed it", () =>
    Effect.gen(function* () {
      const w = world()
      // October 30 is a month of both kinds; only its classification report
      // is broken.
      CLASSIFICATION.brokenOctober(w)
      yield* archive(w, "cron-2026-11-14T06")
      yield* parse(w, CLASSIFICATION, "cron-2026-11-14")
      yield* parse(w, INVESTOR_TYPE, "cron-2026-11-14")
      assert.deepStrictEqual(
        yield* coverage(w, CLASSIFICATION),
        states(CLASSIFICATION, "parsed", "failed")
      )
      assert.deepStrictEqual(
        yield* coverage(w, INVESTOR_TYPE),
        states(INVESTOR_TYPE, "parsed")
      )

      // And the other way: an investor-type failure leaves the
      // classification month as its own run left it.
      CLASSIFICATION.newerOctober(w)
      INVESTOR_TYPE.brokenOctober(w)
      yield* archive(w, "cron-2026-11-14T13")
      yield* parse(w, CLASSIFICATION, "cron-2026-11-15")
      yield* parse(w, INVESTOR_TYPE, "cron-2026-11-15")
      assert.deepStrictEqual(
        yield* coverage(w, CLASSIFICATION),
        states(CLASSIFICATION, "parsed")
      )
      assert.deepStrictEqual(
        yield* coverage(w, INVESTOR_TYPE),
        states(INVESTOR_TYPE, "parsed", "failed")
      )
    })
  )
})
