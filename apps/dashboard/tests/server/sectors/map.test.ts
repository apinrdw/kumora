// The map the dashboard serves at SectorsPath: every stored code's sector and
// industry, and when the table was read.
import { assert, describe, it } from "@effect/vitest"
import { decodeSectorMap } from "@workspace/relay"
import { Effect } from "effect"

import { sectorMapBody } from "@/server/sectors/map"
import { MAX_PROFILES } from "@/server/sectors/sync"

import { memoryHoldingsDb } from "../holdings/memory-holdings-db.ts"

const insert = (
  db: ReturnType<typeof memoryHoldingsDb>,
  code: string,
  sector: string,
  industry: string
) =>
  db.database
    .prepare(
      "INSERT INTO stock_sector VALUES (?, ?, 'sub', ?, 'sub industry', '2026-11-16T15:00:00.000Z')"
    )
    .run(code, sector, industry)

describe("the sector map", () => {
  it.effect("maps each stored code to its sector and industry", () => {
    const db = memoryHoldingsDb()
    insert(db, "BBCA", "Financials", "Banks")
    insert(db, "AADI", "Energy", "Coal")
    return Effect.gen(function* () {
      const map = yield* decodeSectorMap(yield* sectorMapBody)
      assert.deepStrictEqual<unknown>(map, {
        fetchedAt: "2026-11-16T15:00:00.000Z",
        sectors: {
          AADI: { sector: "Energy", industry: "Coal" },
          BBCA: { sector: "Financials", industry: "Banks" },
        },
      })
    }).pipe(Effect.provide(db.layer))
  })

  it.effect("is empty, with no date, before the first run", () => {
    const db = memoryHoldingsDb()
    return Effect.gen(function* () {
      const map = yield* decodeSectorMap(yield* sectorMapBody)
      assert.deepStrictEqual(map, { fetchedAt: null, sectors: {} })
    }).pipe(Effect.provide(db.layer))
  })

  it.effect("holds at most MAX_PROFILES codes, the most a run writes", () => {
    const db = memoryHoldingsDb()
    const add = db.database.prepare(
      "INSERT INTO stock_sector VALUES (?, 'Energy', 'sub', 'Coal', 'sub industry', '2026-11-16T15:00:00.000Z')"
    )
    for (let index = 0; index <= MAX_PROFILES; index++)
      add.run(`C${String(index).padStart(4, "0")}`)
    return Effect.gen(function* () {
      const map = yield* decodeSectorMap(yield* sectorMapBody)
      const codes = Object.keys(map.sectors)
      assert.lengthOf(codes, MAX_PROFILES)
      assert.strictEqual(codes.at(-1), `C${MAX_PROFILES - 1}`)
    }).pipe(Effect.provide(db.layer))
  })

  it.effect("leaves out a row whose sector isn't IDX-IC's", () => {
    const db = memoryHoldingsDb()
    insert(db, "AADI", "Energy", "Coal")
    insert(db, "TKGA", "TRADE, SERVICES & INVESTMENT", "")
    return Effect.gen(function* () {
      const map = yield* decodeSectorMap(yield* sectorMapBody)
      assert.deepStrictEqual(Object.keys(map.sectors), ["AADI"])
    }).pipe(Effect.provide(db.layer))
  })
})
