// The sector table served as one map from stock code to sector (spec
// apinrdw/kumora#427, "Sectors"), at SectorsPath on the Worker entry
// (../market-live/entry.ts). Market Bubbles joins it to its live codes; a
// code it leaves out is Unclassified.
import { IDX_SECTORS, type SectorMap } from "@workspace/relay"
import { Effect } from "effect"

import { HoldingsDb } from "../holdings/db.ts"
import { gatedRead } from "../market-live/days.ts"
import { MAX_PROFILES } from "./sync.ts"

// The table changes once a day, at the sector cron, so a browser keeps its
// copy an hour.
const SECTORS_CACHE = "private, max-age=3600"

const SECTORS: ReadonlySet<string> = new Set(IDX_SECTORS)

// At most MAX_PROFILES rows, the most a run writes.
export const sectorMapBody = Effect.gen(function* () {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: "SELECT code, sector, industry, fetched_at FROM stock_sector ORDER BY code LIMIT ?",
      params: [MAX_PROFILES],
    },
  ])
  const sectors: Record<string, { sector: string; industry: string }> = {}
  let fetchedAt: string | null = null
  for (const row of rows) {
    const sector = String(row.sector)
    fetchedAt = String(row.fetched_at)
    if (SECTORS.has(sector))
      sectors[String(row.code)] = { sector, industry: String(row.industry) }
  }
  return JSON.stringify({ fetchedAt, sectors } satisfies Record<
    keyof SectorMap,
    unknown
  >)
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
