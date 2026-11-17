// The sector table served as one map from stock code to sector (spec
// apinrdw/kumora#427, "Sectors"), at SectorsPath on the Worker entry
// (../market-live/entry.ts). Market Bubbles joins it to its live codes; a
// code it leaves out is Unclassified.
import { Sector, StockCode, type SectorMap } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { HoldingsDb } from "../holdings/db.ts"
import { gatedRead } from "../market-live/days.ts"
import { MAX_PROFILES } from "./sync.ts"

// The table changes once a day, at the sector cron, so a browser keeps its
// copy an hour.
const SECTORS_CACHE = "private, max-age=3600"

const isSector = Schema.is(Sector)
const isStockCode = Schema.is(StockCode)

// At most MAX_PROFILES rows, the most a run writes.
export const sectorMapBody = Effect.gen(function* () {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: "SELECT code, sector, industry, fetched_at FROM stock_sector ORDER BY code LIMIT ?",
      params: [MAX_PROFILES],
    },
  ])
  const sectors: Record<StockCode, SectorMap["sectors"][StockCode]> = {}
  let fetchedAt: string | null = null
  for (const { code, sector, industry, fetched_at } of rows) {
    fetchedAt = String(fetched_at)
    if (isStockCode(code) && isSector(sector))
      sectors[code] = { sector, industry: String(industry) }
  }
  return JSON.stringify({ fetchedAt, sectors } satisfies SectorMap)
})

export const sectorsRoute = (request: Request) =>
  gatedRead(
    request,
    Effect.map(
      sectorMapBody,
      (body) =>
        new Response(body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": SECTORS_CACHE,
          },
        })
    )
  )
