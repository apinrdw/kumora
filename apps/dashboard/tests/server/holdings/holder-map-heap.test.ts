// The Holder map's read at its bound (CODING_STANDARDS.md, "Bounded memory
// on a Worker"): a focus has no cap, so a nominee holding a block of every
// stock reads one whole day and one whole month, each at its parse's cap
// (ADR 0045), and every stored line of them.
import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { HolderKey } from "@/domain/holdings"
import { holderMapView } from "@/lib/holder-map"
import { holderMapRead } from "@/server/holdings/holder-map"

import { retainedHeap } from "../../support/retained-heap.ts"
import { seedAbove1AtCap } from "./above-1-at-cap.ts"
import { ABOVE_5_DAY_ROWS, seedAbove5AtCap } from "./above-5-at-cap.ts"
import { memoryHoldingsDb } from "./memory-holdings-db.ts"

// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
//
// The holder focus retained 25.7 MiB on 27 Nov 2026, its 20,001 nodes with
// it; the stock focus 2.3 MiB.
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
const MONTH = "2025-12-31"
const HUB = "HUB NOMINEE"

// A day and a month at the caps, the first block and row of every stock
// the hub's, and a stored line for every block and row.
const hub = () => {
  const db = memoryHoldingsDb()
  seedAbove5AtCap(db, [DAY], STOCKS, BLOCKS)
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

describe("the Holder map's read of a hub", () => {
  it.effect(
    "focuses a holder of every stock at the parse's caps, in 40 MiB",
    () =>
      Effect.gen(function* () {
        const db = hub()
        const before = yield* retainedHeap
        const read = yield* holderMapRead({
          focus: { kind: "holder", key: HolderKey.make(HUB) },
          day: undefined,
        }).pipe(Effect.provide(db.layer))
        const view = yield* holderMapView(read)
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        // Every stock, in the 5% band, and every other block and row.
        assert.strictEqual(read.links.length, STOCKS.length)
        assert.strictEqual(
          read.hops.length,
          STOCKS.length * (BLOCKS - 1 + MONTH_HOLDERS - 1)
        )
        assert.strictEqual(view.focus?.graph.nodes.length, 1 + 2_000 + 18_000)
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
        const before = yield* retainedHeap
        const read = yield* holderMapRead({
          focus: { kind: "stock", code: StockCode.make("S0000") },
          day: undefined,
        }).pipe(Effect.provide(db.layer))
        const view = yield* holderMapView(read)
        const retained = ((yield* retainedHeap) - before) / 2 ** 20
        // The hub's 1,999 other stocks, a link each.
        assert.strictEqual(read.hops.length, STOCKS.length - 1)
        assert.strictEqual(
          view.focus?.graph.nodes.filter(({ kind }) => kind === "stock").length,
          STOCKS.length
        )
        assert.isBelow(
          retained,
          HEAP_LIMIT_MIB,
          `${retained.toFixed(1)} MiB retained`
        )
      }),
    { timeout: 120_000 }
  )
})
