// The index Durable Object: one, named `index` (routes.ts DAY_INDEX). It
// adapts day-index.ts, which holds the behaviour. Exported from the Worker
// entry (src/worker.ts) as `DayIndex`, the class the dashboard stack declares.
import { WibDate, decodeRecordedDay } from "@workspace/relay"
import { runServerEffect } from "@workspace/server"
import { Effect, Schema } from "effect"

import { durableSql } from "./durable-sql.ts"
import { makeDayIndex } from "./day-index.ts"
import { withMarketClock } from "./market-clock.ts"
import { respond } from "./respond.ts"
import { DayIndexColdPath } from "./routes.ts"

const decodeDate = Schema.decodeUnknownEffect(WibDate)

// Decision: only the bridge and workflow.ts import cloudflare:workers
// (packages/server/docs/adr/0001-only-the-bridge-and-the-workflow-runner-import-cloudflare-workers.md)
export class DayIndexObject {
  private index!: Effect.Success<ReturnType<typeof makeDayIndex>>

  // Cloudflare holds every event until the index is made; a failure resets
  // the object.
  constructor(ctx: DurableObjectState) {
    void ctx.blockConcurrencyWhile(() =>
      runServerEffect(
        Effect.flatMap(durableSql(ctx.storage), makeDayIndex)
      ).then((index) => {
        this.index = index
      })
    )
  }

  // POST: a sealed day's row, or at DayIndexColdPath a cold day's date.
  // GET: the day strip. The runner logs any failure.
  fetch(request: Request): Promise<Response> {
    const body = Effect.promise(() => request.text())
    const posted =
      new URL(request.url).pathname === DayIndexColdPath
        ? body.pipe(
            Effect.flatMap(decodeDate),
            Effect.flatMap(this.index.markCold)
          )
        : body.pipe(
            Effect.flatMap(decodeRecordedDay),
            Effect.flatMap(this.index.record)
          )
    const answer =
      request.method === "POST"
        ? Effect.as(posted, new Response(null, { status: 204 }))
        : withMarketClock(this.index.strip)
    return respond(answer)
  }
}
