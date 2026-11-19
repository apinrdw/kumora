// The Worker the row budgets run in workerd
// (tests/server/market-live/workerd.ts bundles it). One trading-day object,
// named by the busy day's date: POST /build builds the busy day, and
// GET /billed?operation=<name> answers what that operation billed.
import { Effect, Layer } from "effect"

import { BrokerTotalsDb } from "../src/server/broker-totals/db.ts"
import { Fact, type Sql } from "../src/server/market-live/day-store.ts"
import { durableSql } from "../src/server/market-live/durable-sql.ts"
import { respond } from "../src/server/market-live/respond.ts"
import { makeTradingDay } from "../src/server/market-live/trading-day.ts"
import { buildBusyDay } from "./busy-day.ts"
import { BUSY_DAY } from "./busy-figures.ts"
import { operations, type Operation } from "./operations.ts"

// The rows the adapter counted between two of its readings.
const since = (
  before: { readonly rowsRead: number; readonly rowsWritten: number },
  after: { readonly rowsRead: number; readonly rowsWritten: number }
) => ({
  rowsRead: after.rowsRead - before.rowsRead,
  rowsWritten: after.rowsWritten - before.rowsWritten,
})

// A broker totals DB no operation reaches: a build runs on the alarm.
const unreachedDb = Layer.succeed(BrokerTotalsDb)(
  BrokerTotalsDb.of({
    batch: () => Effect.die("The billing worker builds no broker totals"),
  })
)

// The busy day made the day `operation` runs on, before the object wakes.
const restaged = (sql: Sql, stored: Operation["stored"]) =>
  Effect.sync(() => {
    if (stored === "sealed before the summary") {
      sql.exec("DELETE FROM tape_summary")
      sql.exec("DELETE FROM facts WHERE key = ?", Fact.tapeSummary)
    }
    if (stored === "walking") {
      sql.exec("DELETE FROM facts WHERE key = ?", Fact.sealed)
      sql.exec("UPDATE facts SET value = 'walk' WHERE key = ?", Fact.tapeSource)
    }
    if (stored === "batched before the codes-complete fact")
      sql.exec("DELETE FROM facts WHERE key = ?", Fact.codesComplete)
  })

const billed = Effect.fnUntraced(function* (
  storage: DurableObjectStorage,
  operation: Operation
) {
  const sql = yield* durableSql(storage)
  yield* restaged(sql, operation.stored)
  const woke = sql.usage!()
  const day = yield* makeTradingDay({
    date: BUSY_DAY.date,
    sql,
    viewers: Effect.succeed([]),
    viewersOf: () => Effect.succeed([]),
    ...(operation.brokerTotals === true ? { brokerTotalsDb: unreachedDb } : {}),
  })
  const started = sql.usage!()
  if (operation.before !== undefined) yield* operation.before(day)
  const measured = sql.usage!()
  const answer = yield* operation.measure(day)
  const done = sql.usage!()
  const tables = storage.sql
    .exec("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((row) => String(row.name))
  return Response.json({
    start: since(woke, started),
    before: since(started, measured),
    rows: since(measured, done),
    status: answer.status,
    answer: yield* Effect.promise(() => answer.text()),
    tables,
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
