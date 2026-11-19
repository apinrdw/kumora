// The Worker the row budgets run in workerd
// (tests/server/market-live/workerd.ts bundles it). One trading-day object,
// named by the busy day's date: POST /build builds the busy day, GET
// /billed?operation=<name> answers what that operation billed, and POST
// /moved moves the busy day to the local R2 bucket bound as DAYS and answers
// what it billed and how its answers read back. POST /whole-day records a
// whole busy day on an object of its own (billing/whole-day.ts) and answers
// what it billed.
import { gunzipSync } from "node:zlib"

import { StockCode, TradeNumber, type RecordedResource } from "@workspace/relay"
import { Clock, DateTime, Effect, Layer } from "effect"

import { BrokerTotalsDb } from "../src/server/broker-totals/db.ts"
import type { DayBucket } from "../src/server/market-live/cold-bucket.ts"
import { coldAnswer } from "../src/server/market-live/cold-days.ts"
import { Fact, type Sql } from "../src/server/market-live/day-store.ts"
import { durableSql } from "../src/server/market-live/durable-sql.ts"
import { shiftedClock } from "../src/server/market-live/market-clock.ts"
import { respond } from "../src/server/market-live/respond.ts"
import { makeTradingDay } from "../src/server/market-live/trading-day.ts"
import { buildBusyDay } from "./busy-day.ts"
import { BUSY_DAY, WHOLE_DAY } from "./busy-figures.ts"
import { operations, type Operation } from "./operations.ts"
import { wholeDay } from "./whole-day.ts"

interface Env {
  readonly DAY: DurableObjectNamespace
  // A local R2 bucket: alchemy's, run in the same workerd
  // (tests/server/market-live/workerd.ts).
  readonly DAYS: R2Bucket
}

// The rows the adapter counted between two of its readings.
const since = (
  before: { readonly rowsRead: number; readonly rowsWritten: number },
  after: { readonly rowsRead: number; readonly rowsWritten: number }
) => ({
  rowsRead: after.rowsRead - before.rowsRead,
  rowsWritten: after.rowsWritten - before.rowsWritten,
})

const tablesOf = (storage: DurableObjectStorage) =>
  Effect.sync(() =>
    storage.sql
      .exec("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .toArray()
      .map((row) => String(row.name))
  )

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
  const answer = yield* operation.measure(day, sql)
  const done = sql.usage!()
  return Response.json({
    start: since(woke, started),
    before: since(started, measured),
    rows: since(measured, done),
    status: answer.status,
    answer: yield* Effect.promise(() => answer.text()),
    tables: yield* tablesOf(storage),
  })
}, Effect.scoped)

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

const wib = (time: string) =>
  DateTime.makeUnsafe(`${BUSY_DAY.date}T${time}+07:00`)
const BOOK_CODE = StockCode.make(BUSY_DAY.bookCode)

// The answers a move is checked by, each asked of the object before it and
// of R2 after it: the day's, the tape and its codes at the day's end, at
// midday below a trade and in the morning, the book code's views, and its
// book at the open, at midday, and before its first chunk.
const MOVE_CHECKS: ReadonlyArray<RecordedResource> = [
  { _tag: "Codes" },
  { _tag: "Gaps" },
  { _tag: "Tape", at: wib("16:15:00") },
  { _tag: "Tape", at: wib("12:00:00"), before: TradeNumber.make("700000") },
  { _tag: "Tape", at: wib("09:30:00") },
  { _tag: "BrokerCodes", at: wib("16:15:00") },
  {
    _tag: "BrokerCodes",
    at: wib("12:00:00"),
    before: TradeNumber.make("700000"),
  },
  { _tag: "Candles", code: BOOK_CODE },
  { _tag: "Sweeps", code: BOOK_CODE },
  { _tag: "SweepBrokers", code: BOOK_CODE },
  { _tag: "Heatmap", code: BOOK_CODE },
  { _tag: "Book", code: BOOK_CODE, minute: wib("09:00:00") },
  { _tag: "Book", code: BOOK_CODE, minute: wib("12:34:30") },
  { _tag: "Book", code: BOOK_CODE, minute: wib("08:59:00") },
]

// An answer's status and its body as the browser reads it, gunzipped when
// sent gzipped.
const readBack = Effect.fnUntraced(function* (response: Response) {
  const bytes = new Uint8Array(
    yield* Effect.promise(() => response.arrayBuffer())
  )
  const body =
    response.headers.get("Content-Encoding") === "gzip"
      ? gunzipSync(bytes)
      : bytes
  return { status: response.status, body: new TextDecoder().decode(body) }
})

// `bucket`, each get it serves listed: its key, and its range if any.
const listedGets = (bucket: R2Bucket) => {
  const gets: Array<string> = []
  const listed: DayBucket = {
    put: (key, body, options) => bucket.put(key, body, options),
    get: (key, options) => {
      const range = options?.range
      gets.push(
        range === undefined ? key : `${key} ${range.offset}+${range.length}`
      )
      return bucket.get(key, options)
    },
  }
  return { bucket: listed, gets }
}

// The busy day asked to move to `days` and its alarm run until its move
// emptied it, on the move's clock: the rows the move billed and its alarm
// runs, what its deleteAll() billed, the tables left, and each check's
// answer from the object before the move and from R2 after it, with the
// gets each R2 answer made.
const moved = Effect.fnUntraced(function* (
  storage: DurableObjectStorage,
  days: R2Bucket
) {
  const sql = yield* durableSql(storage)
  const r2 = listedGets(days)
  const measured: { emptied?: Record<string, number> } = {}
  const day = yield* makeTradingDay({
    date: BUSY_DAY.date,
    sql,
    viewers: Effect.succeed([]),
    viewersOf: () => Effect.succeed([]),
    cold: {
      bucket: r2.bucket,
      markCold: Effect.void,
      empty: emptyMeasured(storage, sql, measured),
      listed: () => Effect.succeed(false),
      askMove: () => Effect.void,
      anyHour: true,
    },
  })
  const hot = yield* Effect.forEach(MOVE_CHECKS, (resource) =>
    Effect.flatMap(day.recorded(resource), readBack)
  )
  const before = sql.usage!()
  if (!(yield* day.move)) return new Response("Not due", { status: 409 })
  let runs = 0
  while (measured.emptied === undefined && runs < 100) {
    yield* day.alarm
    runs++
  }
  const rows = since(before, sql.usage!())
  if (measured.emptied === undefined)
    return new Response("Not moved", { status: 500 })
  const checks = yield* Effect.forEach(
    MOVE_CHECKS,
    Effect.fnUntraced(function* (resource, index) {
      const from = r2.gets.length
      const answer = yield* coldAnswer(r2.bucket, BUSY_DAY.date, resource)
      if (answer === undefined) return yield* Effect.die("Not stored in R2")
      const cold = yield* readBack(answer)
      return {
        resource: resource._tag,
        hot: hot[index]!,
        cold,
        gets: r2.gets.slice(from),
      }
    })
  )
  return Response.json({
    rows,
    runs,
    emptied: measured.emptied,
    tables: yield* tablesOf(storage),
    checks,
  })
}, Effect.scoped)

const isOperation = (name: string): name is keyof typeof operations =>
  Object.hasOwn(operations, name)

// Decision: a plain class, as TradingDayObject is: only the bridge may
// import `cloudflare:workers`.
export class BillingDay {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env
  ) {}

  fetch(request: Request) {
    const url = new URL(request.url)
    const { storage } = this.ctx
    if (url.pathname === WHOLE_DAY.path)
      return respond(Effect.map(wholeDay(storage), (day) => Response.json(day)))
    if (url.pathname === "/build")
      return respond(
        Effect.map(buildBusyDay(storage), (ms) => Response.json({ ms }))
      )
    if (url.pathname === "/moved")
      return respond(atMoveTime(moved(storage, this.env.DAYS)))
    const name = url.searchParams.get("operation") ?? ""
    if (url.pathname === "/billed" && isOperation(name))
      return respond(billed(storage, operations[name]))
    return new Response("Not found", { status: 404 })
  }
}

export default {
  fetch: (request: Request, env: Env) =>
    env.DAY.getByName(
      new URL(request.url).pathname === WHOLE_DAY.path
        ? "whole-day"
        : BUSY_DAY.date
    ).fetch(request),
}
