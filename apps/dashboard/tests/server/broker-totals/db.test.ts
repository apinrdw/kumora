// Spec apinrdw/kumora#437, "Dashboard: broker totals DB": a built day's
// write and the range read, over the memory D1 fake.
import { assert, describe, it } from "@effect/vitest"
import { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { DateTime, Effect } from "effect"

import {
  readBrokerTotals,
  writeBuiltDay,
  type DayBuild,
} from "@/server/broker-totals/db"

import { memoryBrokerTotalsDb } from "./memory-broker-totals-db.ts"

// D1's largest statement, its SQL and bound values together.
const D1_STATEMENT_BYTES = 100_000

const bytes = (value: string | number | null) =>
  typeof value === "string" ? new TextEncoder().encode(value).length : 0

const BBCA = StockCode.make("BBCA")
const TLKM = StockCode.make("TLKM")
const MON = WibDate.make("2026-11-09")
const TUE = WibDate.make("2026-11-10")
const WED = WibDate.make("2026-11-11")
const BUILT_AT = DateTime.makeUnsafe("2026-11-11T10:00:00Z")

const total = (code: StockCode, broker: string, buyLots: number) => ({
  code,
  broker: BrokerCode.make(broker),
  investorType: "D" as const,
  buyLots,
  buyValue: buyLots * 800_000,
  sellLots: 0,
  sellValue: 0,
})

const candle = (code: StockCode, close: number) => ({
  code,
  open: 8_000,
  high: 8_100,
  low: 7_900,
  close,
  volume: 10,
  value: 8_000_000,
  trades: 12,
})

const small = (close: number): DayBuild => ({
  totals: [total(BBCA, "YP", 2), total(TLKM, "YP", 3)],
  candles: [candle(BBCA, close), candle(TLKM, 3_500)],
  missingTrades: 0,
})

const BROKERS = Array.from({ length: 30 }, (_, at) =>
  String.fromCharCode(65 + Math.floor(at / 26), 65 + (at % 26))
)
// 60 totals rows for each of `codes` codes.
const many = (codes: number): DayBuild => ({
  totals: Array.from({ length: codes }, (_, code) =>
    BROKERS.flatMap((broker) =>
      (["D", "F"] as const).map((investorType) => ({
        ...total(StockCode.make(`C${code}`), broker, code + 1),
        investorType,
      }))
    )
  ).flat(),
  candles: Array.from({ length: codes }, (_, code) =>
    candle(StockCode.make(`C${code}`), 8_000)
  ),
  missingTrades: 0,
})
// About a liquid day's worth: 60,000 totals rows over 1,000 codes.
const large = many(1_000)
// Two batches of totals inserts.
const medium = many(300)

const dump = (db: ReturnType<typeof memoryBrokerTotalsDb>) => ({
  totals: db.database
    .prepare("SELECT * FROM totals ORDER BY code, day, broker, investor_type")
    .all(),
  candles: db.database
    .prepare("SELECT * FROM candles ORDER BY code, day")
    .all(),
  builtDays: db.database.prepare("SELECT * FROM built_days ORDER BY day").all(),
})

describe("a built day's write", () => {
  it.effect(
    "deletes the built-days row first and inserts it last, every statement within D1's size",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        const sqls: Array<ReadonlyArray<string>> = []
        db.failBatch = (sql) => {
          sqls.push(sql)
          return false
        }
        yield* writeBuiltDay(MON, large, 1, BUILT_AT).pipe(
          Effect.provide(db.layer)
        )
        assert.isAbove(sqls.length, 2)
        assert.match(sqls[0]![0]!, /^DELETE FROM built_days/)
        assert.deepStrictEqual(
          sqls.flat().filter((sql) => /built_days/.test(sql)),
          [sqls[0]![0]!, sqls.at(-1)!.at(-1)!]
        )
        assert.match(sqls.at(-1)!.at(-1)!, /^INSERT INTO built_days/)
        assert.isAtMost(
          Math.max(
            ...db.statements.map(
              ({ sql, params }) =>
                bytes(sql) +
                params.reduce<number>((sum, value) => sum + bytes(value), 0)
            )
          ),
          D1_STATEMENT_BYTES
        )
        const counts = db.database
          .prepare(
            "SELECT (SELECT count(*) FROM totals) AS totals, (SELECT count(*) FROM candles) AS candles"
          )
          .get()
        assert.deepStrictEqual(
          { ...counts },
          { totals: 60_000, candles: 1_000 }
        )
      })
  )

  it.effect(
    "that fails part-way leaves no built-days row, and a repeat converges to the same rows",
    () =>
      Effect.gen(function* () {
        const clean = memoryBrokerTotalsDb()
        yield* writeBuiltDay(MON, medium, 1, BUILT_AT).pipe(
          Effect.provide(clean.layer)
        )

        const db = memoryBrokerTotalsDb()
        yield* writeBuiltDay(MON, small(8_000), 1, BUILT_AT).pipe(
          Effect.provide(db.layer)
        )
        let inserts = 0
        db.failBatch = (sql) =>
          sql.some((each) => each.startsWith("INSERT INTO totals")) &&
          ++inserts === 2
        const failed = yield* writeBuiltDay(MON, medium, 1, BUILT_AT).pipe(
          Effect.provide(db.layer),
          Effect.flip
        )
        assert.strictEqual(failed._tag, "BrokerTotalsDbError")
        assert.deepStrictEqual(dump(db).builtDays, [])
        const read = yield* readBrokerTotals(BBCA, MON, MON).pipe(
          Effect.provide(db.layer)
        )
        assert.deepStrictEqual(read, { builtDays: [], candles: [], totals: [] })

        db.failBatch = undefined
        yield* writeBuiltDay(MON, medium, 1, BUILT_AT).pipe(
          Effect.provide(db.layer)
        )
        assert.deepStrictEqual(dump(db), dump(clean))
      })
  )
})

describe("the range read", () => {
  it.effect(
    "returns the asked code's rows, only for built days in the range",
    () =>
      Effect.gen(function* () {
        const db = memoryBrokerTotalsDb()
        const write = (day: WibDate, build: DayBuild) =>
          writeBuiltDay(day, build, 1, BUILT_AT).pipe(Effect.provide(db.layer))
        yield* write(MON, small(8_000))
        yield* write(TUE, small(8_050))
        yield* write(WED, small(8_100))
        // Tuesday rebuilding: its rows are there, its built-days row isn't.
        db.database.prepare("DELETE FROM built_days WHERE day = ?").run(TUE)

        const read = yield* readBrokerTotals(BBCA, TUE, WED).pipe(
          Effect.provide(db.layer)
        )
        assert.deepStrictEqual(read, {
          builtDays: [
            {
              day: WED,
              buildVersion: 1,
              builtAt: "2026-11-11T10:00:00.000Z",
              missingTrades: 0,
            },
          ],
          candles: [
            {
              day: WED,
              open: 8_000,
              high: 8_100,
              low: 7_900,
              close: 8_100,
              volume: 10,
              value: 8_000_000,
              trades: 12,
            },
          ],
          totals: [
            {
              day: WED,
              broker: BrokerCode.make("YP"),
              investorType: "D",
              buyLots: 2,
              buyValue: 1_600_000,
              sellLots: 0,
              sellValue: 0,
            },
          ],
        })
      })
  )
})
