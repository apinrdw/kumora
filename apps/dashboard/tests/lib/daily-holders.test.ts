// The Daily holders view model over one hand-built day: which blocks of a
// stock-day collapse as repeats.
import { assert, describe, it } from "@effect/vitest"
import { BrokerCode, WibDate } from "@workspace/relay"
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
              dataDate: WibDate.make("2026-11-20"),
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

// A holder of `accounts` ([custodian, account name, shares]), its stake
// fixed: a Transfer never changes it.
const holding = (
  name: string,
  accounts: ReadonlyArray<readonly [string, string, number]>
): Above5Holder => ({
  name,
  key: name,
  scripless: accounts.reduce((sum, [, , shares]) => sum + shares, 0),
  percentageHundredths: 922,
  accounts: accounts.map(([custodian, account, scripless]) => ({
    custodian,
    name: account,
    origin: "local",
    domicile: undefined,
    scripless,
  })),
})

const twoDays = (
  before: ReadonlyArray<Above5Holder>,
  now: ReadonlyArray<Above5Holder>
) =>
  dailyHolders(
    [
      {
        dataDate: WibDate.make("2026-11-23"),
        listedShares: undefined,
        holders: before,
      },
      {
        dataDate: WibDate.make("2026-11-24"),
        listedShares: undefined,
        holders: now,
      },
    ],
    undefined
  )

const PROFINDO = "PT PROFINDO SEKURITAS INDONESIA"
const HSBC = "PT Bank HSBC Indonesia"

describe("the Daily holders view model's Transfers", () => {
  // CMNP on 24 Nov 2026: Hamka's 290,000,000 shares left HSBC for
  // Profindo (RG), his total unchanged.
  it.effect(
    "mark a holder whose shares crossed to another broker, total unchanged, as Transfer",
    () =>
      Effect.gen(function* () {
        const day = yield* twoDays(
          [
            holding("MOHAMMAD JUSUF HAMKA", [
              [PROFINDO, "MOHAMAD JUSUF HAMKA", 37_433_696],
              [HSBC, "MOHAMAD JUSUF HAMKA", 580_293_900],
            ]),
          ],
          [
            holding("MOHAMMAD JUSUF HAMKA", [
              [PROFINDO, "MOHAMAD JUSUF HAMKA", 327_433_696],
              [HSBC, "MOHAMAD JUSUF HAMKA", 290_293_900],
            ]),
          ]
        )
        assert.deepInclude(day?.listed[0], {
          move: "transfer",
          shareChange: 0,
          stake: { before: 922, now: 922 },
          transfer: {
            from: ["custodian"],
            to: [BrokerCode.make("RG")],
            shares: 290_000_000,
          },
        })
        assert.strictEqual(day?.listed[0]?.trend.at(-1), "transfer")
        assert.deepStrictEqual(day?.counts, {
          new: 0,
          up: 0,
          down: 0,
          transfer: 1,
          offList: 0,
        })
      })
  )

  it.effect(
    "keep a holder Unchanged whose shares moved between accounts at one broker",
    () =>
      Effect.gen(function* () {
        const day = yield* twoDays(
          [holding("PT SATU", [[PROFINDO, "PT SATU A", 1_000]])],
          [holding("PT SATU", [[PROFINDO, "PT SATU B", 1_000]])]
        )
        assert.deepInclude(day?.listed[0], {
          move: "unchanged",
          transfer: undefined,
        })
      })
  )

  it.effect(
    "keep a holder Unchanged whose shares moved between two spellings of one broker",
    () =>
      Effect.gen(function* () {
        const day = yield* twoDays(
          [holding("PT TIGA", [[PROFINDO, "PT TIGA", 1_000]])],
          [
            holding("PT TIGA", [
              [PROFINDO, "PT TIGA", 400],
              ["Profindo Sekuritas Indonesia, PT", "PT TIGA", 600],
            ]),
          ]
        )
        assert.deepInclude(day?.listed[0], {
          move: "unchanged",
          transfer: undefined,
        })
      })
  )

  it.effect(
    "keep a holder Up whose total grew while shares also crossed brokers",
    () =>
      Effect.gen(function* () {
        const day = yield* twoDays(
          [holding("PT DUA", [[HSBC, "PT DUA", 1_000]])],
          [
            holding("PT DUA", [
              [HSBC, "PT DUA", 200],
              [PROFINDO, "PT DUA", 900],
            ]),
          ]
        )
        assert.deepInclude(day?.listed[0], {
          move: "up",
          shareChange: 100,
          transfer: undefined,
        })
      })
  )
})
