// The above-5% parse run's test world: fake IDX listing the above-5%
// fixtures, a real archive run, and real parse runs, read through the stock
// page.
import { StockCode } from "@workspace/relay"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { RunId } from "@/server/archive/run"
import { stockPage } from "@/server/holdings/stock-page"
import type { above1ParseRuns } from "@/server/shareholding/above-1-parse"
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
import { archiveDbOf } from "../archive/runs.ts"
import { type MemoryBucket, memoryBucket } from "../archive/memory-bucket.ts"
import {
  type MemoryHoldingsDb,
  memoryHoldingsDb,
} from "../holdings/memory-holdings-db.ts"

export interface World {
  readonly idx: FakeIdx
  readonly bucket: MemoryBucket
  readonly holdings: MemoryHoldingsDb
}

// IDX listing the above-5% fixtures' reports, with the investor-type reports
// their listed shares come from unless `withoutListedShares`, and the
// above-1% fixtures' when `withAbove1`.
export const world = ({
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
export const archive = ({ idx, bucket }: World, id: string) =>
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

export const runParse =
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

export const parse = runParse(above5ParseRuns)
const parseInvestorType = runParse(investorTypeParseRuns)

// Archives every listed report, parses the investor-type ones for their
// listed shares, then runs the above-5% parse run.
export const archiveAndParse = Effect.fnUntraced(function* (
  w: World,
  id: string
) {
  yield* archive(w, `${id}T13`)
  yield* parseInvestorType(w, id)
  return yield* parse(w, id)
})

// IDX replaces a day's report in place with a fixture's bytes.
export const republish = (
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

// A stock's page as the stock page reads it.
export const pageOf = ({ holdings }: World, code: string) =>
  stockPage(StockCode.make(code), undefined).pipe(
    Effect.provide(holdings.layer)
  )

// A stock's above-5% blocks of `dataDate` as the stock page reads them, in
// report order.
export const heldOn = (w: World, dataDate: string, code: string) =>
  Effect.map(
    pageOf(w, code),
    ({ dailyHolders }) =>
      dailyHolders.find((day) => day.dataDate === dataDate)?.holders ?? []
  )
