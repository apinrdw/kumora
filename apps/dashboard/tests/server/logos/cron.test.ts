// The logo cron's codes: every code of the sector table, which a new listing
// joins the day IDX lists it, with the holdings' codes, so a stage whose
// sector table is empty still syncs.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { logoCodes } from "@/server/logos/cron"
import { MAX_PROFILES } from "@/server/sectors/sync"

import { memoryHoldingsDb } from "../holdings/memory-holdings-db.ts"

describe("the logo cron's codes", () => {
  it.effect(
    "are the sector table's codes and the holdings' codes, once each",
    () => {
      const db = memoryHoldingsDb()
      db.database.exec(`
      INSERT INTO stock_sector (code, sector, sub_sector, industry, sub_industry, fetched_at)
      VALUES ('AADI', 'Energy', '', '', '', '2026-11-16T15:00:00.000Z'),
             ('NEWW', 'Technology', '', '', '', '2026-11-16T15:00:00.000Z');
      INSERT INTO ksei_month (period_end, sha256, parser_version, parsed_at)
      VALUES ('2026-10-31', 'x', 1, '2026-11-01T00:00:00.000Z');
      INSERT INTO ksei_stock_month (period_end, stock_code, listed_shares, price, total_scripless)
      VALUES ('2026-10-31', 'AADI', 1, 1, 1), ('2026-10-31', 'BBCA', 1, 1, 1);
    `)
      return Effect.gen(function* () {
        assert.deepStrictEqual(yield* logoCodes, ["AADI", "BBCA", "NEWW"])
      }).pipe(Effect.provide(db.layer))
    }
  )

  it.effect(
    "are at most MAX_PROFILES, with a full sector table and holdings besides",
    () => {
      const db = memoryHoldingsDb()
      const add = db.database.prepare(
        "INSERT INTO stock_sector VALUES (?, 'Energy', '', '', '', '2026-11-16T15:00:00.000Z')"
      )
      for (let index = 0; index < MAX_PROFILES; index++)
        add.run(`C${String(index).padStart(4, "0")}`)
      db.database.exec(`
      INSERT INTO ksei_month (period_end, sha256, parser_version, parsed_at)
      VALUES ('2026-10-31', 'x', 1, '2026-11-01T00:00:00.000Z');
      INSERT INTO ksei_stock_month (period_end, stock_code, listed_shares, price, total_scripless)
      VALUES ('2026-10-31', 'BBCA', 1, 1, 1);
    `)
      return Effect.gen(function* () {
        assert.lengthOf(yield* logoCodes, MAX_PROFILES)
      }).pipe(Effect.provide(db.layer))
    }
  )
})
