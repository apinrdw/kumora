// The Daily holders view model over one hand-built day: which blocks of a
// stock-day collapse as repeats.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { dailyHolders } from "@/lib/daily-holders"
import type { Above5Holder } from "@/server/holdings/stock-page"

const block = (key: string, custodian: string): Above5Holder => ({
  name: "PT SAMA NAMA",
  key,
  scripless: 1_000,
  percentageHundredths: 600,
  accounts: [
    {
      custodian,
      name: "PT SAMA NAMA",
      origin: "local",
      domicile: undefined,
      scripless: 1_000,
    },
  ],
})

describe("the Daily holders view model's repeat blocks", () => {
  it.effect(
    "keep two blocks apart whose accounts match but at different custodians",
    () =>
      Effect.gen(function* () {
        const day = yield* dailyHolders(
          [
            {
              dataDate: "2026-11-20",
              listedShares: undefined,
              holders: [
                block("PT SAMA NAMA 1", "PT CUSTODIAN A"),
                block("PT SAMA NAMA 2", "PT CUSTODIAN B"),
              ],
            },
          ],
          undefined
        )
        assert.deepStrictEqual(
          day?.listed.map(({ accounts }) =>
            accounts.map(({ custodian }) => custodian)
          ),
          [["PT CUSTODIAN A"], ["PT CUSTODIAN B"]]
        )
        assert.strictEqual(day?.totalHundredths, 1200)
      })
  )
})
