// The daily sector run: IDX's company profiles replace the stock_sector
// table in one batch, unless the run fails a sanity gate, which keeps
// yesterday's table whole.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { PROFILES_URL, syncSectors } from "@/server/sectors/sync"

import { memoryHoldingsDb } from "../holdings/memory-holdings-db.ts"
import { codes, fakeIdx, profile } from "./fake-idx.ts"

const setup = () => {
  const idx = fakeIdx()
  const db = memoryHoldingsDb()
  return { idx, db, layer: Layer.merge(idx.layer, db.layer) }
}

const rows = (db: ReturnType<typeof memoryHoldingsDb>) =>
  db.database
    .prepare(
      "SELECT code, sector, sub_sector, industry, sub_industry, fetched_at FROM stock_sector ORDER BY code"
    )
    .all()

const yesterday = new Date("2026-11-15T15:00:00Z")
const today = new Date("2026-11-16T15:00:00Z")

describe("the sector run", () => {
  it.effect(
    "replaces the table with every profile's four levels, trimmed",
    () => {
      const { idx, db, layer } = setup()
      return Effect.gen(function* () {
        idx.profiles = [profile("BBCA", "Financials"), profile("AADI")]
        yield* syncSectors(yesterday)
        idx.profiles = [
          { ...profile("AADI"), Sektor: " Energy ", Industri: "Coal " },
          profile("TLKM", "Infrastructures"),
        ]
        const outcome = yield* syncSectors(today)

        assert.deepStrictEqual(outcome, {
          _tag: "Replaced",
          rows: 2,
          skipped: [],
        })
        assert.deepStrictEqual(idx.requests.at(-1), PROFILES_URL)
        assert.deepStrictEqual(
          rows(db).map((row) => ({ ...row })),
          [
            {
              code: "AADI",
              sector: "Energy",
              sub_sector: "Oil, Gas & Coal",
              industry: "Coal",
              sub_industry: "Coal Production",
              fetched_at: "2026-11-16T15:00:00.000Z",
            },
            {
              code: "TLKM",
              sector: "Infrastructures",
              sub_sector: "Oil, Gas & Coal",
              industry: "Coal",
              sub_industry: "Coal Production",
              fetched_at: "2026-11-16T15:00:00.000Z",
            },
          ]
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "keeps yesterday's table when the profiles drop under 90 % of it",
    () => {
      const { idx, db, layer } = setup()
      return Effect.gen(function* () {
        idx.profiles = codes(100).map((code) => profile(code))
        yield* syncSectors(yesterday)
        idx.profiles = codes(89).map((code) => profile(code))
        const outcome = yield* syncSectors(today)

        assert.strictEqual(outcome._tag, "Kept")
        assert.strictEqual(rows(db).length, 100)
        assert.isTrue(
          rows(db).every((row) => row.fetched_at === "2026-11-15T15:00:00.000Z")
        )

        // 90 of 100 passes.
        idx.profiles = codes(90).map((code) => profile(code))
        assert.deepStrictEqual(yield* syncSectors(today), {
          _tag: "Replaced",
          rows: 90,
          skipped: [],
        })
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "skips a profile whose sector falls outside the 11 IDX-IC sectors, and replaces the table with the rest",
    () => {
      const { idx, db, layer } = setup()
      return Effect.gen(function* () {
        // A stale JASICA record, as IDX kept for AGII on 2026-11-18.
        idx.profiles = [
          profile("AADI"),
          profile("AGII", "3. Basic Industry And Chemicals"),
          profile("BBCA", "Financials"),
        ]
        assert.deepStrictEqual(yield* syncSectors(today), {
          _tag: "Replaced",
          rows: 2,
          skipped: ["AGII (3. Basic Industry And Chemicals)"],
        })
        assert.deepStrictEqual(
          rows(db).map((row) => row.code),
          ["AADI", "BBCA"]
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect(
    "skips a profile whose code isn't a stock code, and replaces the table with the rest",
    () => {
      const { idx, db, layer } = setup()
      return Effect.gen(function* () {
        idx.profiles = [
          profile("AADI"),
          profile("bad code"),
          profile("BBCA", "Financials"),
        ]
        assert.deepStrictEqual(yield* syncSectors(today), {
          _tag: "Replaced",
          rows: 2,
          skipped: ['"bad code" (no stock code)'],
        })
        assert.deepStrictEqual(
          rows(db).map((row) => row.code),
          ["AADI", "BBCA"]
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("keeps an empty table when no profile has an IDX-IC sector", () => {
    const { idx, db, layer } = setup()
    return Effect.gen(function* () {
      idx.profiles = [profile("AADI", "Energi"), profile("BBCA", "Keuangan")]
      assert.deepStrictEqual(yield* syncSectors(today), {
        _tag: "Kept",
        reason:
          "IDX lists 0 company profiles with a stock code and an IDX-IC sector, under 90 % of the 0 stored",
      })
      assert.strictEqual(rows(db).length, 0)
    }).pipe(Effect.provide(layer))
  })

  // At the most profiles a run accepts; IDX listed 944 on 2026-11-16.
  it.effect("fills an empty table from the first run", () => {
    const { idx, db, layer } = setup()
    return Effect.gen(function* () {
      idx.profiles = codes(5000).map((code) => profile(code, "Technology"))
      assert.deepStrictEqual(yield* syncSectors(today), {
        _tag: "Replaced",
        rows: 5000,
        skipped: [],
      })
      assert.strictEqual(rows(db).length, 5000)
      // One batch: the old rows go and the new come in one transaction.
      assert.strictEqual(
        db.statements.filter(({ sql }) => sql.startsWith("DELETE")).length,
        1
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("fails, and keeps the table, when IDX answers an error", () => {
    const { idx, db, layer } = setup()
    return Effect.gen(function* () {
      idx.profiles = [profile("AADI")]
      yield* syncSectors(yesterday)
      idx.response = () => new Response("Service unavailable", { status: 503 })
      const failed = yield* Effect.flip(syncSectors(today))

      assert.include(failed.message, "503")
      assert.strictEqual(rows(db).length, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("fails, and keeps the table, when IDX changes the shape", () => {
    const { idx, db, layer } = setup()
    return Effect.gen(function* () {
      idx.profiles = [profile("AADI")]
      yield* syncSectors(yesterday)
      idx.response = () => Response.json({ items: [] })
      const failed = yield* Effect.flip(syncSectors(today))

      assert.include(failed.message, "Schema")
      assert.strictEqual(rows(db).length, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("refuses more profiles than the table holds", () => {
    const { idx, db, layer } = setup()
    return Effect.gen(function* () {
      idx.profiles = codes(5001, "X").map((code) => profile(code))
      const failed = yield* Effect.flip(syncSectors(today))

      assert.include(failed.message, "5,000")
      assert.strictEqual(rows(db).length, 0)
    }).pipe(Effect.provide(layer))
  })
})
