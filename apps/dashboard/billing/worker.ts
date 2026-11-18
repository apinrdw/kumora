// The Worker the row budgets run in workerd
// (tests/server/market-live/workerd.ts bundles it). One trading-day object,
// named by the busy day's date: POST /build builds the busy day, and
// GET /billed?operation=<name> answers what that operation billed.
import { Effect } from "effect"

import { durableSql } from "../src/server/market-live/durable-sql.ts"
import { respond } from "../src/server/market-live/respond.ts"
import { makeTradingDay } from "../src/server/market-live/trading-day.ts"
import { BUSY_DAY, buildBusyDay } from "./busy-day.ts"
import { operations, type Operation } from "./operations.ts"

// The rows the adapter counted between two of its readings.
const since = (
  before: { readonly rowsRead: number; readonly rowsWritten: number },
  after: { readonly rowsRead: number; readonly rowsWritten: number }
) => ({
  rowsRead: after.rowsRead - before.rowsRead,
  rowsWritten: after.rowsWritten - before.rowsWritten,
})

const billed = Effect.fnUntraced(function* (
  storage: DurableObjectStorage,
  operation: Operation
) {
  const sql = yield* durableSql(storage)
  const day = yield* makeTradingDay({
    date: BUSY_DAY.date,
    sql,
    viewers: Effect.succeed([]),
    viewersOf: () => Effect.succeed([]),
  })
  const started = sql.usage!()
  if (operation.before !== undefined) yield* operation.before(day)
  const measured = sql.usage!()
  const answer = yield* operation.measure(day)
  const done = sql.usage!()
  return Response.json({
    start: since({ rowsRead: 0, rowsWritten: 0 }, started),
    before: since(started, measured),
    rows: since(measured, done),
    status: answer.status,
    answer: yield* Effect.promise(() => answer.text()),
  })
}, Effect.scoped)

const isOperation = (name: string): name is keyof typeof operations =>
  Object.hasOwn(operations, name)

// Decision: a plain class, as TradingDayObject is: only the bridge may
// import `cloudflare:workers`.
export class BillingDay {
  constructor(private readonly ctx: DurableObjectState) {}

  fetch(request: Request) {
    const url = new URL(request.url)
    const { storage } = this.ctx
    if (url.pathname === "/build")
      return respond(
        Effect.map(buildBusyDay(storage), (ms) => Response.json({ ms }))
      )
    const name = url.searchParams.get("operation") ?? ""
    if (url.pathname === "/billed" && isOperation(name))
      return respond(billed(storage, operations[name]))
    return new Response("Not found", { status: 404 })
  }
}

export default {
  fetch: (request: Request, env: { readonly DAY: DurableObjectNamespace }) =>
    env.DAY.getByName(BUSY_DAY.date).fetch(request),
}
