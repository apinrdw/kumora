// The special_board table served as one list of codes (spec
// apinrdw/kumora#517, "Ticks, limits and excluded codes"), at
// SpecialBoardPath on the Worker entry (../market-live/entry.ts), as the
// sector map is (../sectors/map.ts). The Book readout shows a board code's
// reason in place of readings.
import { StockCode, type SpecialBoard } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { HoldingsDb } from "../holdings/db.ts"
import { gatedRead } from "../market-live/days.ts"
import { MAX_BOARD_CODES } from "./sync.ts"

// The table changes once a day, at the board cron, so a browser keeps its
// copy an hour.
const SPECIAL_BOARD_CACHE = "private, max-age=3600"

const isStockCode = Schema.is(StockCode)

// At most MAX_BOARD_CODES rows, the most a run writes.
export const specialBoardBody = Effect.gen(function* () {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: "SELECT code, fetched_at FROM special_board ORDER BY code LIMIT ?",
      params: [MAX_BOARD_CODES],
    },
  ])
  const codes = new Array<StockCode>()
  let fetchedAt: string | null = null
  for (const { code, fetched_at } of rows) {
    fetchedAt = String(fetched_at)
    if (isStockCode(code)) codes.push(code)
  }
  return JSON.stringify({ fetchedAt, codes } satisfies SpecialBoard)
})

export const specialBoardRoute = (request: Request) =>
  gatedRead(
    request,
    Effect.map(
      specialBoardBody,
      (body) =>
        new Response(body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": SPECIAL_BOARD_CACHE,
          },
        })
    )
  )
