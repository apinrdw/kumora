import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { seedFilenames, seedModule } from "./ksei-wayback-seed.mts"

const HEADER = ["original", "timestamp", "statuscode"]

describe("seedFilenames", () => {
  it.effect(
    "keeps each KSEI report's filename once, from captures and revisits",
    () =>
      Effect.gen(function* () {
        const names = yield* seedFilenames([
          [
            HEADER,
            [
              "http://www.ksei.co.id/Download/StatisEfek20080131.txt.zip",
              "20151017065254",
              "200",
            ],
            [
              "http://www.ksei.co.id:80/Download/BalanceposEfek20081031.txt.zip",
              "20151017065254",
              "-",
            ],
            ["http://www.ksei.co.id:80/Download/", "20100427010242", "403"],
            [
              "http://www.ksei.co.id/Download/BalanceposEfek20140131.zip",
              "20151017065254",
              "404",
            ],
            [
              "http://www.ksei.co.id/Download/StatisEfek20080131.txt.zip?x=1",
              "20160101000000",
              "200",
            ],
          ],
          [
            HEADER,
            [
              "https://web.ksei.co.id/Download/BalanceposEfek20250228.zip",
              "20260131181859",
              "200",
            ],
            [
              "https://web.ksei.co.id/Download/StatisEfek20080131.txt.zip",
              "20260131181859",
              "200",
            ],
            [
              "https://web.ksei.co.id/Download/3._Layout_dan_Contoh_File_Upload_Download_S-INVEST.zip",
              "20260304065507",
              "200",
            ],
          ],
        ])
        assert.deepStrictEqual(names, [
          "BalanceposEfek20081031.txt.zip",
          "BalanceposEfek20250228.zip",
          "StatisEfek20080131.txt.zip",
        ])
      })
  )
})

describe("seedModule", () => {
  it.effect("writes the names as a constant", () =>
    Effect.gen(function* () {
      const module = yield* seedModule(["A.zip", "B.zip"])
      assert.include(
        module,
        'export const WAYBACK_SEED: ReadonlyArray<string> = [\n  "A.zip",\n  "B.zip",\n]\n'
      )
    })
  )
})
