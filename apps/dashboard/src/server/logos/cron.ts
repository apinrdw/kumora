// The logo cron's handler, which runCron (../crons.ts) calls for the Worker
// entry's `scheduled`. It returns a Promise for the reason the shareholding
// archive's (../shareholding/cron.ts) does.
import { runServerEffectResult } from "@workspace/server"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"

import { r2ArchiveBucket } from "../archive/bucket-r2.ts"
import { holdingsDbD1 } from "../holdings/db.ts"
import { stockList } from "../holdings/stock-page.ts"
import { syncLogos } from "./sync.ts"

// Decision: the codes are the stock page's list, every code HoldingsDb has
// parsed holdings for, the one list of every listed code the server keeps.
// A new listing joins once its first report is parsed. See apinrdw/kumora#432.
const syncListedLogos = stockList.pipe(
  Effect.flatMap((stocks) => syncLogos(stocks.map(({ code }) => code))),
  Effect.asVoid
)

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
