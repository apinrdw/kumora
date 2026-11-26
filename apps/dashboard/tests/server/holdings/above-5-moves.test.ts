// Holder moves' Daily derivation over days written straight into a memory
// HoldingsDb: a holder's history from before its Trend's days, against the
// stock page's Daily holders, and the days a parsed day makes stale.
import { assert, describe, it } from "@effect/vitest"
import { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { dailyHolders } from "@/lib/daily-holders"
import { deriveMoveDay, staleMoveDays } from "@/server/holdings/above-5-moves"
import { holderMovesView } from "@/lib/holder-moves"
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

  it.effect("derives again every day after one parsed again", () =>
    Effect.gen(function* () {
      const db = memoryHoldingsDb()
      const dates = datesOf(24)
      seed(db, dates, () => ["ALPHA", 1_000])
      const stale = yield* Effect.gen(function* () {
        for (const day of yield* staleMoveDays()) yield* deriveMoveDay(day)
        const derived = yield* staleMoveDays()
        db.database
          .prepare(
            "UPDATE above_5_day SET sha256 = 'again' WHERE data_date = ?"
          )
          .run(dates[1] ?? "")
        return { derived, again: yield* staleMoveDays() }
      }).pipe(Effect.provide(db.layer))
      assert.deepStrictEqual(stale, {
        derived: [],
        again: dates.slice(1).map((date) => WibDate.make(date)),
      })
    })
  )

  // CMNP on 24 Nov 2026: Hamka's 290,000,000 shares left HSBC for Profindo
  // (RG), his total unchanged.
  it.effect("stores a Transfer and reads it back with its brokers", () =>
    Effect.gen(function* () {
      const db = memoryHoldingsDb()
      const dates = ["2026-11-23", "2026-11-24"]
      const day = db.database.prepare(
        "INSERT INTO above_5_day VALUES (?, 'sha', 1, '2026-11-25T00:00:00Z')"
      )
      const holder = db.database.prepare(
        `INSERT INTO above_5_holder VALUES
          (?, 'CMNP', 1, 'CITRA MARGA', 'HAMKA', 'HAMKA', ?, 922)`
      )
      const account = db.database.prepare(
        `INSERT INTO above_5_account VALUES
          (?, 'CMNP', 1, ?, ?, 'HAMKA', 'local', NULL, NULL, ?)`
      )
      for (const [date, profindo, hsbc] of [
        ["2026-11-23", 37_433_696, 580_293_900],
        ["2026-11-24", 327_433_696, 290_293_900],
      ] as const) {
        day.run(date)
        holder.run(date, profindo + hsbc)
        account.run(date, 1, "PT PROFINDO SEKURITAS INDONESIA", profindo)
        account.run(date, 2, "PT Bank HSBC Indonesia", hsbc)
      }
      const view = yield* Effect.gen(function* () {
        for (const date of dates) yield* deriveMoveDay(WibDate.make(date))
        return yield* holderMovesView(
          yield* holderMovesRead({
            kind: "daily",
            day: WibDate.make(dates[1] ?? ""),
          })
        )
      }).pipe(Effect.provide(db.layer))
      assert.deepInclude(view?.lines[0], {
        name: "HAMKA",
        move: "transfer",
        shareChange: 0,
        transfer: {
          from: ["custodian"],
          to: [BrokerCode.make("RG")],
          shares: 290_000_000,
        },
        trend: [null, "transfer"],
      })
      assert.deepStrictEqual(view?.counts, {
        new: 0,
        up: 0,
        down: 0,
        transfer: 1,
        offList: 0,
      })
      assert.deepStrictEqual(view?.rail.at(-1)?.counts, view?.counts)
    })
  )
})
