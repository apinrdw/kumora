// The Holder map's read at its bound (CODING_STANDARDS.md, "Bounded memory
// on a Worker"): a focus has no cap, so a nominee holding a block of every
// stock, or a custodian of every account, reads one whole day and one whole
// month, each at its parse's cap (ADR 0045), and every stored line of them.
import { assert, describe, it } from "@effect/vitest"
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Layer, Schema } from "effect"

import { CustodianId, HolderKey } from "@/domain/holdings"
import { holderMapView } from "@/lib/holder-map"
import { HoldingsDb } from "@/server/holdings/db"
import { holderMapRead } from "@/server/holdings/holder-map"
import { holderMapSearchList } from "@/server/holdings/holder-map-search-list"

import { retainedHeap } from "../../support/retained-heap.ts"
import { seedAbove1AtCap } from "./above-1-at-cap.ts"
import { ABOVE_5_DAY_ROWS, seedAbove5AtCap } from "./above-5-at-cap.ts"
import {
  memoryHoldingsDb,
  type MemoryHoldingsDb,
} from "./memory-holdings-db.ts"

// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
//
// The holder focus retained 32.4 MiB on 27 Nov 2026, its 20,005 nodes,
// 8,000 custodian links and its side panel's hop beyond with it; the
// custodian focus 13.7 MiB, and 8.9 MiB with 7,999 Off list holdings;
// the stock focus 1.8 MiB, and 9.1 MiB with 80,000 stored leavings. In
// every case no statement returns more rows than its budget.
const HEAP_LIMIT_MIB = 40

// The most stocks a report lists (ADR 0045), each with the day's blocks
// and the month's rows shared out: 8,000 blocks and 14,000 rows.
const STOCKS = Array.from(
  { length: 2_000 },
  (_, at) => `S${String(at).padStart(4, "0")}`
)
const BLOCKS = ABOVE_5_DAY_ROWS / STOCKS.length
const MONTH_HOLDERS = 7
const DAY = "2026-01-05"
// The trading day before DAY.
const PREV = "2026-01-02"
const MONTH = "2025-12-31"
const HUB = "HUB NOMINEE"
const HUB_CUSTODIAN = "PT HUB CUSTODIAN"
// The month holders of a stock whose keys each left the above-5% list
// 4,000 times since (codex review of apinrdw/kumora#741, round 6).
const CROSSING_HOLDERS = 20
const LEAVINGS_PER_KEY = 4_000
// A stock's former holders after years of churn (codex review of
// apinrdw/kumora#741: 80,000 retained about 119 MiB unbounded).
const CHURNED = 80_000

// A day and a month at the caps, the first block and row of every stock
// the hub's, and a stored line for every block and row.
const hub = (days: ReadonlyArray<string> = [DAY]) => {
  const db = memoryHoldingsDb()
  seedAbove5AtCap(db, days, STOCKS, BLOCKS)
  seedAbove1AtCap(db, [MONTH], STOCKS, MONTH_HOLDERS)
  const { database } = db
  database
    .prepare(
      `UPDATE above_5_holder SET holder_key = ?
        WHERE holder_key LIKE 'HOLDER ' || stock_code || ' 0X%'`
    )
    .run(HUB)
  database
    .prepare("UPDATE above_1_holding SET holder_key = ? WHERE seq = 1")
    .run(HUB)
  database.exec(`INSERT INTO above_5_move
    SELECT data_date, stock_code, holder_key || '#1', issuer_name,
      holder_name, '[]', NULL, 'up', '[]', 1, 500, 501, 1, '[]', NULL
    FROM above_5_holder`)
  database.exec(`INSERT INTO above_1_move
    SELECT data_date, stock_code, holder_key || '#' || seq, issuer_name,
      investor_name, '[]', NULL, 'up', '[]', 1, 100, 101, 1, '[]', NULL
    FROM above_1_holding`)
  return db
}

const isBudgeted = Schema.is(
  Schema.Struct({ sql: Schema.String, rows: Schema.Number })
)

// `db`, and each statement it ran that has no row budget or returned more
// rows than it (`Budgeted` in holder-map-schema.ts), by its SQL's end.
const budgeted = (db: MemoryHoldingsDb) => {
  const over: Array<string> = []
  const layer = Layer.effect(
    HoldingsDb,
    Effect.gen(function* () {
      const inner = yield* HoldingsDb
      return HoldingsDb.of({
        batch: (statements) =>
          Effect.tap(inner.batch(statements), (rows) =>
            Effect.sync(() => {
              statements.forEach((statement, at) => {
                const returned = rows[at]?.length ?? 0
                const budget = isBudgeted(statement)
                  ? statement.rows
                  : undefined
                if (budget === undefined || returned > budget)
                  over.push(
                    `…${statement.sql.replaceAll(/\s+/g, " ").slice(-60)}: ${returned} rows, budget ${budget ?? "none"}`
                  )
              })
            })
          ),
      })
    })
  ).pipe(Layer.provide(db.layer))
  return { over, layer }
}

describe("the Holder map's read of a hub", () => {
  it.effect(
    "focuses a holder of every stock at the parse's caps, in 40 MiB",
    () =>
      Effect.gen(function* () {
        const { over, layer } = budgeted(hub())
        const before = yield* retainedHeap
        const read = yield* holderMapRead({
          focus: { kind: "holder", key: HolderKey.make(HUB) },
          day: undefined,
        }).pipe(Effect.provide(layer))
        const view = yield* holderMapView(read)
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        // Every stock, in the 5% band, and every other block and row.
        assert.strictEqual(read.links.length, STOCKS.length)
        assert.strictEqual(
          read.hops.length,
          STOCKS.length * (BLOCKS - 1 + MONTH_HOLDERS - 1)
        )
        // And the custodians of the day's accounts.
        assert.strictEqual(
          view.focus?.graph.nodes.length,
          1 + 2_000 + 18_000 + BLOCKS
        )
        assert.deepStrictEqual(over, [])
        assert.isBelow(
          retained,
          HEAP_LIMIT_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 120_000 }
  )

  it.effect(
    "focuses a custodian of every account at the parse's caps, in 40 MiB",
    () =>
      Effect.gen(function* () {
        const db = hub()
        db.database
          .prepare("UPDATE above_5_account SET custodian = ?")
          .run(HUB_CUSTODIAN)
        const { over, layer } = budgeted(db)
        const before = yield* retainedHeap
        const read = yield* holderMapRead({
          focus: {
            kind: "custodian",
            id: CustodianId.make("NAME:CUSTODIAN HUB"),
          },
          day: undefined,
        }).pipe(Effect.provide(layer))
        const view = yield* holderMapView(read)
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        // Every block of the day, through it.
        assert.strictEqual(read.links.length, ABOVE_5_DAY_ROWS)
        assert.strictEqual(read.custodians.length, ABOVE_5_DAY_ROWS)
        // It, the hub and every other block's holder, and every stock.
        assert.strictEqual(
          view.focus?.graph.nodes.length,
          1 + 1 + (ABOVE_5_DAY_ROWS - STOCKS.length) + STOCKS.length
        )
        assert.deepStrictEqual(over, [])
        assert.isBelow(
          retained,
          HEAP_LIMIT_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 120_000 }
  )

  it.effect(
    "focuses a custodian that held every account the day before, in 40 MiB",
    () =>
      Effect.gen(function* () {
        const db = hub([PREV, DAY])
        db.database
          .prepare(
            "UPDATE above_5_account SET custodian = ? WHERE data_date = ?"
          )
          .run(HUB_CUSTODIAN, PREV)
        // Still holding one block through it.
        db.database
          .prepare(
            "UPDATE above_5_account SET custodian = ? WHERE data_date = ? AND no = 1"
          )
          .run(HUB_CUSTODIAN, DAY)
        const { over, layer } = budgeted(db)
        const before = yield* retainedHeap
        const read = yield* holderMapRead({
          focus: {
            kind: "custodian",
            id: CustodianId.make("NAME:CUSTODIAN HUB"),
          },
          day: undefined,
        }).pipe(Effect.provide(layer))
        const view = yield* holderMapView(read)
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        // Every block of the day before, a day's at the cap, but the one
        // still held through it.
        assert.strictEqual(read.links.length, 1)
        assert.strictEqual(read.offList.length, ABOVE_5_DAY_ROWS - 1)
        assert.strictEqual(view.focus?.offList.length, ABOVE_5_DAY_ROWS - 1)
        assert.deepStrictEqual(over, [])
        assert.isBelow(
          retained,
          HEAP_LIMIT_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 120_000 }
  )

  it.effect(
    "focuses a stock with years of churned holders, in 40 MiB",
    () =>
      Effect.gen(function* () {
        const db = hub()
        // A holder off the list each day across years: every stored
        // leaving the Off list could read, ten times its budget.
        db.database.exec(`WITH RECURSIVE n(at) AS (
            SELECT 1 UNION ALL SELECT at + 1 FROM n WHERE at < ${CHURNED}
          )
          INSERT INTO above_5_move
          SELECT date('2020-01-01', '+' || (at % 1500) || ' days'), 'S0000',
            'FORMER HOLDER ' || at || '#1', 'ISSUER S0000',
            'FORMER HOLDER ' || at, '[]', NULL, 'off list', '[]', NULL, 600,
            NULL, NULL, '[]', NULL
          FROM n`)
        const { over, layer } = budgeted(db)
        const before = yield* retainedHeap
        const read = yield* holderMapRead({
          focus: { kind: "stock", code: StockCode.make("S0000") },
          day: undefined,
        }).pipe(Effect.provide(layer))
        const view = yield* holderMapView(read)
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        // The newest whole days' leavings that fit a day's accounts at the
        // cap: 150 days of 53.
        assert.strictEqual(read.offList.length, 7_950)
        assert.strictEqual(view.focus?.offList.length, 7_950)
        assert.isTrue(view.focus?.offListCut)
        assert.deepStrictEqual(over, [])
        assert.isBelow(
          retained,
          HEAP_LIMIT_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 120_000 }
  )

  it.effect(
    "focuses a stock whose holder holds every stock, in 40 MiB",
    () =>
      Effect.gen(function* () {
        const db = hub()
        const { over, layer } = budgeted(db)
        const before = yield* retainedHeap
        const read = yield* holderMapRead({
          focus: { kind: "stock", code: StockCode.make("S0000") },
          day: undefined,
        }).pipe(Effect.provide(layer))
        const view = yield* holderMapView(read)
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        // The hub's 1,999 other stocks, a link each.
        assert.strictEqual(read.hops.length, STOCKS.length - 1)
        assert.strictEqual(
          view.focus?.graph.nodes.filter(({ kind }) => kind === "stock").length,
          STOCKS.length
        )
        assert.deepStrictEqual(over, [])
        assert.isBelow(
          retained,
          HEAP_LIMIT_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 120_000 }
  )

  it.effect(
    "focuses a custodian that left a holding on each of 30 days, in 40 MiB",
    () =>
      Effect.gen(function* () {
        // One stock, each day a cap's blocks all listing the same shares,
        // so each is one a holding of its day could repeat (codex review of
        // apinrdw/kumora#741, round 4). The custodian held block n through
        // day n, and holds the last block on the as-of day.
        const days = Array.from({ length: 31 }, (_, at) =>
          new Date(Date.UTC(2025, 11, 1 + at)).toISOString().slice(0, 10)
        )
        const db = memoryHoldingsDb()
        seedAbove5AtCap(db, days, ["S0000"], ABOVE_5_DAY_ROWS)
        const { database } = db
        database.exec("UPDATE above_5_holder SET scripless = 1000")
        database.exec("UPDATE above_5_account SET scripless = 1000")
        const through = database.prepare(
          "UPDATE above_5_account SET custodian = ? WHERE data_date = ? AND no = ?"
        )
        days.forEach((date, at) =>
          through.run(
            HUB_CUSTODIAN,
            date,
            at === days.length - 1 ? ABOVE_5_DAY_ROWS : at + 1
          )
        )
        const { over, layer } = budgeted(db)
        const before = yield* retainedHeap
        const read = yield* holderMapRead({
          focus: {
            kind: "custodian",
            id: CustodianId.make("NAME:CUSTODIAN HUB"),
          },
          day: undefined,
        }).pipe(Effect.provide(layer))
        const view = yield* holderMapView(read)
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        // No statement passes its budget, the Off list's a day at the cap:
        // it keeps the newest day whose blocks and accounts fit.
        assert.deepStrictEqual(over, [])
        // The newest holding left, and older ones said to be left out.
        assert.strictEqual(read.links.length, 1)
        assert.strictEqual(view.focus?.offList.length, 1)
        assert.isTrue(view.focus?.offListCut)
        assert.isBelow(
          retained,
          HEAP_LIMIT_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 240_000 }
  )

  it.effect(
    "focuses a stock whose month holders each left the list 4,000 times, in each statement's budget",
    () =>
      Effect.gen(function* () {
        // 20 holders of the month, each key with 4,000 earlier identities
        // that left the above-5% list after the month (codex review of
        // apinrdw/kumora#741, round 6: 80,000 crossing rows).
        const db = memoryHoldingsDb()
        seedAbove5AtCap(db, [DAY], ["S0000"], 1)
        seedAbove1AtCap(db, [MONTH], ["S0000"], CROSSING_HOLDERS)
        db.database.exec(`WITH RECURSIVE n(at) AS (
            SELECT 1 UNION ALL SELECT at + 1 FROM n WHERE at < ${LEAVINGS_PER_KEY}
          )
          INSERT INTO above_5_move
          SELECT '${PREV}', stock_code, holder_key || '#' || at, issuer_name,
            investor_name, '[]', NULL, 'off list', '[]', NULL, 600, NULL,
            NULL, '[]', NULL
          FROM above_1_holding, n`)
        const { over, layer } = budgeted(db)
        const before = yield* retainedHeap
        const read = yield* holderMapRead({
          focus: { kind: "stock", code: StockCode.make("S0000") },
          day: undefined,
        }).pipe(Effect.provide(layer))
        const view = yield* holderMapView(read)
        const held = yield* holderMapRead({
          focus: {
            kind: "holder",
            key: HolderKey.make(read.links[1]?.holder ?? ""),
          },
          day: undefined,
        }).pipe(Effect.provide(layer))
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        assert.deepStrictEqual(over, [])
        // Each month holder Down out of 5% since its newest leaving.
        assert.deepStrictEqual(
          read.links
            .filter(({ band }) => band === "1%")
            .map(({ crossing }) => crossing),
          Array.from({ length: CROSSING_HOLDERS }, () => ({
            kind: "down out of 5%" as const,
            since: WibDate.make(PREV),
          }))
        )
        assert.strictEqual(view.focus?.offList.length, 0)
        assert.deepStrictEqual(
          held.links.map(({ crossing }) => crossing?.kind),
          ["down out of 5%"]
        )
        assert.isBelow(
          retained,
          HEAP_LIMIT_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 120_000 }
  )

  it.effect(
    "lists the picker's days and the search's stocks, holders and custodians in each statement's budget",
    () =>
      Effect.gen(function* () {
        const db = hub()
        // More parsed days than a day's rows at the cap, all before DAY.
        db.database.exec(`WITH RECURSIVE n(at) AS (
            SELECT 1 UNION ALL SELECT at + 1 FROM n WHERE at < ${ABOVE_5_DAY_ROWS}
          )
          INSERT INTO above_5_day
          SELECT date('2000-01-01', '+' || at || ' days'), 'sha', 1,
            '2026-11-25T00:00:00Z'
          FROM n`)
        const { over, layer } = budgeted(db)
        const read = yield* holderMapRead({
          focus: undefined,
          day: undefined,
        }).pipe(Effect.provide(layer))
        const list = yield* holderMapSearchList(undefined).pipe(
          Effect.provide(layer)
        )
        assert.deepStrictEqual(over, [])
        // The newest days that fit, oldest first, up to the map's.
        assert.strictEqual(read.days.length, ABOVE_5_DAY_ROWS)
        assert.strictEqual(read.days.at(-1), DAY)
        assert.strictEqual(list.stocks.length, STOCKS.length)
      }),
    { timeout: 120_000 }
  )
})
