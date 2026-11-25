// Holder moves' Daily derivation against the stock page's Daily holders,
// over days written straight into a memory HoldingsDb: a holder's history
// from before its Trend's days.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { dailyHolders } from "@/lib/daily-holders"
import { deriveMoveDay } from "@/server/holdings/above-5-moves"
import { holderMovesRead } from "@/server/holdings/holder-moves"
import { stockPage } from "@/server/holdings/stock-page"

import { datesOf } from "./above-5-at-cap.ts"
import {
  type MemoryHoldingsDb,
  memoryHoldingsDb,
} from "./memory-holdings-db.ts"

const CODE = StockCode.make("RTRN")

// `dates`' parsed days, and the stock's one holder on those `held` gives a
// name and shares.
const seed = (
  { database }: MemoryHoldingsDb,
  dates: ReadonlyArray<string>,
  held: (at: number) => readonly [name: string, shares: number] | undefined
) => {
  const day = database.prepare(
    "INSERT INTO above_5_day VALUES (?, 'sha', 1, '2026-11-25T00:00:00Z')"
  )
  const holder = database.prepare(
    "INSERT INTO above_5_holder VALUES (?, ?, 1, 'PT RETURN TBK', ?, ?, ?, 900)"
  )
  const account = database.prepare(
    `INSERT INTO above_5_account VALUES
      (?, ?, 1, 1, 'PT CUSTODIAN', ?, 'local', NULL, NULL, ?)`
  )
  dates.forEach((date, at) => {
    day.run(date)
    const listing = held(at)
    if (listing === undefined) return
    const [name, shares] = listing
    holder.run(date, CODE, name, name, shares)
    account.run(date, CODE, `${name} ${at}`, shares)
  })
}

describe("Holder moves' Daily derivation", () => {
  // ALPHA is renamed BETA on the second day (equal shares), BETA buys 10
  // shares a day, leaves on the 21st day, and ALPHA is back on the 24th,
  // whose Trend's days start at the 5th.
  it.effect(
    "gives a holder back from before its Trend's days the Trend its Daily holders shows",
    () =>
      Effect.gen(function* () {
        const db = memoryHoldingsDb()
        const dates = datesOf(24)
        seed(db, dates, (at) =>
          at === 0
            ? ["ALPHA", 1_000]
            : at < 20
              ? ["BETA", 1_000 + (at - 1) * 10]
              : at === 23
                ? ["ALPHA", 5_000]
                : undefined
        )
        const day = WibDate.make(dates.at(-1) ?? "")
        const trends = yield* Effect.gen(function* () {
          yield* deriveMoveDay(day)
          const { lines } = yield* holderMovesRead({ kind: "daily", day })
          const panel = yield* dailyHolders(
            (yield* stockPage(CODE, undefined)).dailyHolders,
            day
          )
          return {
            moves: lines.map(({ name, trend }) => ({ name, trend })),
            panel: panel?.listed.map(({ name, trend }) => ({ name, trend })),
          }
        }).pipe(Effect.provide(db.layer))
        assert.deepStrictEqual(trends.panel, [
          {
            name: "ALPHA",
            trend: [
              ...Array.from({ length: 16 }, () => 10),
              "out",
              null,
              null,
              "in",
            ],
          },
        ])
        assert.deepStrictEqual(trends.moves, trends.panel)
      })
  )
})
