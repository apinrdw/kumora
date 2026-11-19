// The Worker the row budgets run in workerd
// (tests/server/market-live/workerd.ts bundles it). One trading-day object,
// named by the busy day's date: POST /build builds the busy day, and
// GET /billed?operation=<name> answers what that operation billed. POST
// /whole-day records a whole busy day on an object of its own
// (billing/whole-day.ts) and answers what it billed.
import { Clock, Effect, Layer } from "effect"

import { BrokerTotalsDb } from "../src/server/broker-totals/db.ts"
import { Fact, type Sql } from "../src/server/market-live/day-store.ts"
import type { DayBucket } from "../src/server/market-live/cold-bucket.ts"
import { durableSql } from "../src/server/market-live/durable-sql.ts"
import { shiftedClock } from "../src/server/market-live/market-clock.ts"
import { respond } from "../src/server/market-live/respond.ts"
import { makeTradingDay } from "../src/server/market-live/trading-day.ts"
import { buildBusyDay } from "./busy-day.ts"
import { BUSY_DAY, WHOLE_DAY } from "./busy-figures.ts"
import { operations, type Operation } from "./operations.ts"
import { wholeDay } from "./whole-day.ts"

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

// A recorded days bucket in the worker's memory: what a move puts, and the
// gets of nothing.
const memoryBucket = (): DayBucket => {
  const objects = new Map<string, Uint8Array | string>()
  return {
    put: (key, body) =>
      Effect.runPromise(Effect.sync(() => void objects.set(key, body))),
    get: () => Effect.runPromise(Effect.succeed(null)),
  }
}

// The rows a deleteAll() of the object billed, as the adapter counts them,
// the database's bytes before and after it, and the rows its tables held,
// counted past the adapter.
const emptyMeasured = (
  storage: DurableObjectStorage,
  sql: Sql,
  measured: { emptied?: Record<string, number> }
) =>
  Effect.gen(function* () {
    const held = yield* Effect.sync(() => {
      let rows = 0
      for (const { name } of storage.sql
        .exec("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .toArray())
        rows += Number(
          storage.sql
            .exec(`SELECT count(*) AS rows FROM "${String(name)}"`)
            .one().rows
        )
      return { rows, bytes: storage.sql.databaseSize, usage: sql.usage!() }
    })
    yield* Effect.promise(() => storage.deleteAll())
    measured.emptied = {
      ...since(held.usage, sql.usage!()),
      rowsHeld: held.rows,
      bytesBefore: held.bytes,
      bytesAfter: storage.sql.databaseSize,
    }
  })

// Decision: a move runs at midnight ten trading days after the busy day,
// out of its window, on a clock shifted there: the worker's own clock reads
// whenever the suite runs.
const MOVED_AT = Date.parse("2026-11-24T00:00:00+07:00")

const atMoveTime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const base = yield* Clock.Clock
    return yield* Effect.provideService(
      effect,
      Clock.Clock,
      yield* shiftedClock(base, MOVED_AT - base.currentTimeMillisUnsafe())
    )
  })

const billed = Effect.fnUntraced(function* (
  storage: DurableObjectStorage,
  operation: Operation
) {
  const sql = yield* durableSql(storage)
  yield* restaged(sql, operation.stored)
  const woke = sql.usage!()
  const moving: { emptied?: Record<string, number> } = {}
  const day = yield* makeTradingDay({
    date: BUSY_DAY.date,
    sql,
    viewers: Effect.succeed([]),
    viewersOf: () => Effect.succeed([]),
    ...(operation.brokerTotals === true ? { brokerTotalsDb: unreachedDb } : {}),
    ...(operation.moves === true
      ? {
          cold: {
            bucket: memoryBucket(),
            markCold: Effect.void,
            empty: emptyMeasured(storage, sql, moving),
            listed: () => Effect.succeed(false),
            askMove: () => Effect.void,
            anyHour: true,
          },
        }
      : {}),
  })
  const started = sql.usage!()
  if (operation.before !== undefined) yield* operation.before(day)
  const measured = sql.usage!()
  const answer = yield* operation.measure(day, sql, {
    emptied: Effect.sync(() => moving.emptied),
  })
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
    if (url.pathname === WHOLE_DAY.path)
      return respond(Effect.map(wholeDay(storage), (day) => Response.json(day)))
    if (url.pathname === "/build")
      return respond(
        Effect.map(buildBusyDay(storage), (ms) => Response.json({ ms }))
      )
    const name = url.searchParams.get("operation") ?? ""
    if (url.pathname === "/billed" && isOperation(name)) {
      const operation: Operation = operations[name]
      const run = billed(storage, operation)
      return respond(operation.moves === true ? atMoveTime(run) : run)
    }
    return new Response("Not found", { status: 404 })
  }
}

export default {
  fetch: (request: Request, env: { readonly DAY: DurableObjectNamespace }) =>
    env.DAY.getByName(
      new URL(request.url).pathname === WHOLE_DAY.path
        ? "whole-day"
        : BUSY_DAY.date
    ).fetch(request),
}
