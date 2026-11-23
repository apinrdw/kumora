// The logo cron's handler, which runCron (../crons.ts) calls for the Worker
// entry's `scheduled`. It returns a Promise for the reason the shareholding
// archive's (../shareholding/cron.ts) does.
import { StockCode } from "@workspace/relay"
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"

import { r2ArchiveBucket } from "../archive/bucket-r2.ts"
import { HoldingsDb, holdingsDbD1 } from "../holdings/db.ts"
import { stockList } from "../holdings/stock-page.ts"
import { MAX_PROFILES } from "../sectors/sync.ts"
import { syncLogos } from "./sync.ts"

const isStockCode = Schema.is(StockCode)

// The codes are the sector table's, which the daily sector run
// fills from IDX's listings, so a new listing gets its logo the week it
// lists; with the stock page's list of codes HoldingsDb has holdings for,
// so a stage whose sector table is empty still syncs. At most MAX_PROFILES
// of them, as the sector map. See apinrdw/kumora#427.
export const logoCodes = Effect.gen(function* () {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: "SELECT code FROM stock_sector ORDER BY code LIMIT ?",
      params: [MAX_PROFILES],
    },
  ])
  const codes = new Set<StockCode>()
  for (const { code } of rows) if (isStockCode(code)) codes.add(code)
  for (const { code } of yield* stockList) codes.add(code)
  return [...codes].sort().slice(0, MAX_PROFILES)
})

const syncListedLogos = Effect.asVoid(Effect.flatMap(logoCodes, syncLogos))

export const runLogoCron = () =>
  runServerEffectResult(
    syncListedLogos.pipe(
      Effect.provide(
        Layer.mergeAll(
          r2ArchiveBucket((env) => env.LOGO_BUCKET),
          holdingsDbD1,
          FetchHttpClient.layer
        )
      )
    )
  )
