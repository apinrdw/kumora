// The index Durable Object: one, named `index` (routes.ts DAY_INDEX). It
// adapts day-index.ts, which holds the behaviour. Exported from the Worker
// entry (src/worker.ts) as `DayIndex`, the class the dashboard stack declares.
import { decodeRecordedDay } from "@workspace/relay"
import { runServerEffectResult } from "@workspace/server"
import { Effect, Result } from "effect"

import { durableSql } from "./durable-sql.ts"
import { makeDayIndex } from "./day-index.ts"
import { withMarketClock } from "./market-clock.ts"

// Decision: a plain class, like the trading-day object: fetch only, and only
// the bridge may import `cloudflare:workers`.
export class DayIndexObject {
  private readonly index

  constructor(ctx: DurableObjectState) {
    this.index = Effect.runSync(makeDayIndex(durableSql(ctx.storage)))
  }

  // POST: a sealed day's row. GET: the day strip. The runner logs any
  // failure.
  fetch(request: Request): Promise<Response> {
    const answer =
      request.method === "POST"
        ? Effect.promise(() => request.text()).pipe(
            Effect.flatMap(decodeRecordedDay),
            Effect.flatMap(this.index.record),
            Effect.as(new Response(null, { status: 204 }))
          )
        : withMarketClock(this.index.strip)
    return runServerEffectResult(answer).then((settled) =>
      Result.isSuccess(settled)
        ? settled.success
        : new Response(null, { status: 500 })
    )
  }
}
