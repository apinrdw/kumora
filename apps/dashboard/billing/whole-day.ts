// A whole busy day recorded by a fresh trading day, for the whole-day
// budgets (spec apinrdw/kumora#555, "Testing Decisions"): the relay's
// Stockbit frames from 09:00 to 16:15 WIB on the TestClock, a viewer
// watching WHOLE_DAY.viewed codes so their books are recorded, the seal at
// 17:00, then the evening's Ajaib walk of every trade's broker codes. It
// answers what the day billed, its database's size, and the figures the
// spec's PR reports.
import { gunzipSync } from "node:zlib"

import {
  BOOK_DEPTH,
  BrokerCodesProtocolVersion,
  IngestProtocolVersion,
  StockCode,
  TradeNumber,
  ViewerProtocolVersion,
  encodeBrokerCodesBatch,
  encodeIngestUp,
  encodeViewerUp,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Logger, References } from "effect"
import { TestClock } from "effect/testing"

import type { Sql } from "../src/server/market-live/day-store.ts"
import { durableSql } from "../src/server/market-live/durable-sql.ts"
import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "../src/server/market-live/trading-day.ts"
import {
  doubleField,
  messageField,
  runningTradeBatch,
  stringField,
  varintField,
  type StockbitRow,
} from "../tests/server/market-live/protobuf.ts"
import { BUSY_DAY, WHOLE_DAY, busyCodes } from "./busy-figures.ts"

// Every code sends a liveprice frame each minute, and the 30 busiest are
// viewed, their books framed on both sides every 15 s.
// Decision: the busy day's trades come in bursts of BURST, one code and side
// each, the code drawn by Zipf's law over its 800 codes: about 0.31 sweeps
// a trade and 145 K stock-minutes, near the cost model's 0.3 and 150 K
// (docs/runbooks/order-flow-cost.md, "First estimate").
const BURST = 3
const OPEN = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-11-09T09:00:00+07:00")
)
const MINUTES = 435
const SPAN_MS = MINUTES * 60_000
const SEAL = DateTime.toEpochMillis(
  DateTime.makeUnsafe("2026-11-09T17:00:00+07:00")
)
const BOOK_EVERY_MS = 15_000
// Decision: the relay's frames land in one envelope every 5 s, holding the
// trades timed before its end. A flush takes a minute's settled trades
// whatever envelopes brought them, and the day records in about 280 s
// against 325 s with an envelope a second.
const ENVELOPE_MS = 5_000
const TOKEN = "whole-day-ingest-token"
const WIB_MS = 7 * 3_600_000

// A uniform draw in [0, 1) for `n`, the same on every run.
const unit = (n: number) => {
  let x = Math.imul(n, 2_654_435_761) >>> 0
  x = (x ^ (x >>> 15)) >>> 0
  x = Math.imul(x, 2_246_822_519) >>> 0
  x = (x ^ (x >>> 13)) >>> 0
  return x / 4_294_967_296
}

const cumulative = (() => {
  const weights = Array.from(
    { length: BUSY_DAY.codes },
    (_, at) => 1 / (at + 1)
  )
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let sum = 0
  return weights.map((weight) => (sum += weight / total))
})()

// The code rank a draw `u` lands on.
const rankOf = (u: number) => {
  let low = 0
  let high = BUSY_DAY.codes - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (cumulative[middle]! < u) low = middle + 1
    else high = middle
  }
  return low
}

const codeOf = (rank: number) => `C${rank}`
const timeOf = (number: number) =>
  OPEN + Math.floor(((number - 1) * SPAN_MS) / BUSY_DAY.trades)
const wib = (ms: number) => new Date(ms + WIB_MS).toISOString().slice(11, 23)

// Trade `number` as Stockbit's running trade batch carries it: its burst's
// code and side, the price stepping one tick a trade through the burst.
const tradeRow = (number: number): StockbitRow => {
  const burst = Math.floor((number - 1) / BURST)
  const step = (number - 1) % BURST
  const rank = rankOf(unit(burst + 1))
  const buy = unit(burst + 7) < 0.5
  return {
    tradeWib: wib(timeOf(number)),
    code: codeOf(rank),
    price: 1_000 + (rank % 50) * 10 + (buy ? step : -step),
    volume: (1 + Math.floor(unit(number + 13) * 50)) * 100,
    action: buy ? 1 : 2,
    board: 1,
    tradeNumber: number,
  }
}

// Stockbit's `order_book` frame of one full side of `code`'s book at `ms`,
// 20 levels whose lots move with `frame`.
const bookFrame = (
  code: string,
  side: "BID" | "OFFER",
  frame: number,
  ms: number
) => {
  const levels = Array.from({ length: BOOK_DEPTH }, (_, index) => {
    const price = 1_000 + (side === "BID" ? -1 : 1) * (index + 1)
    const lots = 100 + ((frame * 7 + index * 13) % 900)
    return `${price};${1 + ((frame + index) % 30)};${lots * 100}`
  })
  const body = [
    "#O",
    code,
    side,
    ...levels,
    `0-${BOOK_DEPTH}&${BOOK_DEPTH * 50_000}`,
  ].join("|")
  return Uint8Array.from(
    messageField(10, [
      ...stringField(1, code),
      ...stringField(2, body),
      ...stringField(5, `2026-11-09T${wib(ms)}+07:00`),
    ])
  )
}

// Stockbit's regular-board `liveprice` frame of `code` at `ms`.
const livePriceFrame = (code: string, last: number, ms: number) =>
  Uint8Array.from(
    messageField(9, [
      ...stringField(1, code),
      ...doubleField(2, last),
      ...doubleField(3, 1_000_000),
      ...doubleField(7, 100),
      ...stringField(11, `2026-11-09T${wib(ms)}+07:00`),
      ...doubleField(13, 1_000),
      ...doubleField(14, 5e9),
      ...messageField(15, [
        ...doubleField(1, last - 1_000),
        ...doubleField(2, ((last - 1_000) / 1_000) * 100),
      ]),
      ...varintField(23, 1),
    ])
  )

// A socket that discards what it is sent: the relay, or the viewer.
const peer = (watching: ReadonlyArray<StockCode> = []): Peer => {
  let state: PeerState = "new"
  let codes = watching
  return {
    send: () => Effect.void,
    close: () => Effect.void,
    open: Effect.succeed(true),
    state: Effect.sync(() => state),
    setState: (next) =>
      Effect.sync(() => {
        state = next
      }),
    watching: Effect.sync(() => codes),
    setWatching: (next) =>
      Effect.sync(() => {
        codes = next
      }),
  }
}

const env = Layer.succeed(WorkerEnv)(
  // Only the binding the object reads.
  { INGEST_TOKEN: TOKEN } as unknown as WorkerEnv["Service"]
)

interface Rows {
  readonly rowsRead: number
  readonly rowsWritten: number
}

// The figures each `Rows written` and `Sweep brokers recomputed` line
// carried, summed over the day.
const meterLines = () => {
  const sums: Record<string, number> = {}
  const logger = Logger.make(({ message, fiber }) => {
    const [text] = Array.isArray(message) ? message : [message]
    if (text !== "Rows written" && text !== "Sweep brokers recomputed") return
    const annotations = fiber.getRef(References.CurrentLogAnnotations)
    for (const [key, value] of Object.entries(annotations))
      if (typeof value === "number") sums[key] = (sums[key] ?? 0) + value
  })
  return { sums, layer: Logger.layer([logger]) }
}

type TradingDay = Effect.Success<ReturnType<typeof makeTradingDay>>

const VIEWED = Array.from({ length: WHOLE_DAY.viewed }, (_, rank) =>
  StockCode.make(codeOf(rank))
)

// The relay's frames of the envelope ending at `end`: its trades in one
// batch frame, the viewed codes' books every 15 s, and each code's last
// price in a liveprice frame as each minute ends. `tape` is how far the
// trades went, and each code's last price.
const envelopeFrames = (
  end: number,
  tape: { next: number; readonly prices: Map<string, number> }
) => {
  const rows: Array<StockbitRow> = []
  while (tape.next <= BUSY_DAY.trades && timeOf(tape.next) < end) {
    const row = tradeRow(tape.next++)
    tape.prices.set(row.code, row.price)
    rows.push(row)
  }
  const frames = rows.length > 0 ? [runningTradeBatch(rows)] : []
  const since = end - OPEN
  if (since % BOOK_EVERY_MS === 0)
    for (const code of VIEWED)
      frames.push(
        bookFrame(code, "BID", since / BOOK_EVERY_MS, end - 1),
        bookFrame(code, "OFFER", since / BOOK_EVERY_MS, end - 1)
      )
  if (since % 60_000 === 0)
    for (let rank = 0; rank < BUSY_DAY.codes; rank++)
      frames.push(
        livePriceFrame(
          codeOf(rank),
          tape.prices.get(codeOf(rank)) ?? 1_000,
          end - 1
        )
      )
  return frames
}

// The relay's token, then its frames from 09:00 to 16:15 on the clock.
const liveHours = Effect.fnUntraced(function* (day: TradingDay) {
  const relay = peer()
  yield* day.ingestMessage(
    relay,
    yield* encodeIngestUp({
      _tag: "Token",
      protocolVersion: IngestProtocolVersion,
      token: TOKEN,
    })
  )
  const tape = { next: 1, prices: new Map<string, number>() }
  for (let end = OPEN; end < OPEN + SPAN_MS;) {
    end += ENVELOPE_MS
    yield* TestClock.setTime(end)
    yield* day.ingestMessage(
      relay,
      yield* encodeIngestUp({
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Stockbit",
        connection: "A",
        receivedAt: yield* DateTime.now,
        frames: envelopeFrames(end, tape),
      })
    )
  }
})

// Ajaib's walk batch of trades `first` to `last`, the day's last ending it.
const walkBatch = (first: number, last: number) =>
  encodeBrokerCodesBatch({
    version: BrokerCodesProtocolVersion,
    feed: "Ajaib",
    day: BUSY_DAY.date,
    rows: Array.from({ length: last - first + 1 }, (_, at) => {
      const number = first + at
      return [TradeNumber.make(String(number)), busyCodes(number)] as const
    }),
    ...(last === BUSY_DAY.trades
      ? { end: { n: TradeNumber.make(String(last)) } }
      : {}),
  })

const walk = Effect.fnUntraced(function* (day: TradingDay) {
  for (let first = 1; first <= BUSY_DAY.trades; first += WHOLE_DAY.walkBatch) {
    const last = Math.min(first + WHOLE_DAY.walkBatch - 1, BUSY_DAY.trades)
    const response = yield* day.brokerCodes.post(yield* walkBatch(first, last))
    if (response.status !== 200)
      return yield* Effect.die(`Walk batch answered ${response.status}`)
  }
})

// The day recorded on `sql`: a viewer selects the viewed codes and leaves,
// as their books stay recorded until the close; the live hours, the seal,
// then the walk, each with the rows it billed.
const recordDay = Effect.fnUntraced(function* (sql: Sql) {
  const usage = (): Rows => {
    const { rowsRead, rowsWritten } = sql.usage!()
    return { rowsRead, rowsWritten }
  }
  const billed = <E, R>(work: Effect.Effect<unknown, E, R>) =>
    Effect.gen(function* () {
      const before = usage()
      yield* work
      const after = usage()
      return {
        rowsRead: after.rowsRead - before.rowsRead,
        rowsWritten: after.rowsWritten - before.rowsWritten,
      }
    })
  yield* TestClock.setTime(OPEN - 60_000)
  const viewers = [peer()]
  const day = yield* makeTradingDay({
    date: BUSY_DAY.date,
    sql,
    viewers: Effect.sync(() => viewers),
    viewersOf: () => Effect.succeed([]),
  })
  const started = usage()
  const viewer = viewers[0]!
  yield* day.viewerMessage(
    viewer,
    yield* encodeViewerUp({
      _tag: "Select",
      protocolVersion: ViewerProtocolVersion,
      selected: VIEWED[0]!,
      watchlist: VIEWED.slice(1),
    })
  )
  viewers.pop()
  yield* day.viewerClosed(viewer)
  // The last flushes land before the seal's alarm.
  const live = yield* billed(
    Effect.andThen(liveHours(day), TestClock.adjust("5 minutes"))
  )
  const seal = yield* billed(Effect.andThen(TestClock.setTime(SEAL), day.alarm))
  const walked = yield* billed(walk(day))
  const ended = usage()
  return {
    live,
    seal,
    walk: walked,
    total: {
      rowsRead: ended.rowsRead - started.rowsRead,
      rowsWritten: ended.rowsWritten - started.rowsWritten,
    },
  }
}, Effect.scoped)

// Each table's payload bytes, largest first: a number counts 8, a text or
// blob its length. workerd's SQLite has no dbstat table for the bytes on
// disk; `databaseSize` is their total.
const tableBytes = (storage: DurableObjectStorage) => {
  const sizes: Array<readonly [string, number]> = []
  const tables = storage.sql
    .exec(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'"
    )
    .toArray()
  for (const { name } of tables) {
    const columns = storage.sql
      .exec(`PRAGMA table_info(${String(name)})`)
      .toArray()
      .map(
        ({ name: column }) =>
          `COALESCE(SUM(CASE typeof(${String(column)}) WHEN 'integer' THEN 8 WHEN 'real' THEN 8 ELSE length(CAST(${String(column)} AS BLOB)) END), 0)`
      )
    const bytes = storage.sql
      .exec(`SELECT ${columns.join(" + ")} AS n FROM ${String(name)}`)
      .one().n
    sizes.push([String(name), Number(bytes)])
  }
  return Object.fromEntries(sizes.sort(([, a], [, b]) => b - a))
}

// The sweep brokers rows' payload bytes, stored and as plain JSON.
const sweepBrokerBytes = (storage: DurableObjectStorage) => {
  let stored = 0
  let plain = 0
  let rows = 0
  for (const row of storage.sql.exec("SELECT sweeps FROM sweep_brokers")) {
    const value = row.sweeps
    rows++
    if (value instanceof ArrayBuffer) {
      stored += value.byteLength
      plain += gunzipSync(new Uint8Array(value)).byteLength
    } else {
      const length = new TextEncoder().encode(String(value)).byteLength
      stored += length
      plain += length
    }
  }
  return { rows, stored, plain, ratio: plain / Math.max(stored, 1) }
}

const counted = (storage: DurableObjectStorage, query: string) =>
  Number(storage.sql.exec(query).one().n)

// The whole day recorded in `storage`, and what it billed.
export const wholeDay = Effect.fnUntraced(function* (
  storage: DurableObjectStorage
) {
  const meter = meterLines()
  const billed = yield* recordDay(yield* durableSql(storage)).pipe(
    Effect.provide(Layer.mergeAll(TestClock.layer(), env, meter.layer))
  )
  return {
    ...billed,
    written: meter.sums,
    databaseBytes: storage.sql.databaseSize,
    tables: tableBytes(storage),
    sweepBrokers: sweepBrokerBytes(storage),
    tradeChunks: {
      rows: counted(storage, "SELECT COUNT(*) AS n FROM trade_chunks"),
      bytes: counted(
        storage,
        "SELECT SUM(length(records)) AS n FROM trade_chunks"
      ),
    },
    bookCodes: counted(
      storage,
      "SELECT COUNT(DISTINCT code) AS n FROM book_chunks"
    ),
    stockMinutes: counted(storage, "SELECT COUNT(*) AS n FROM candles"),
  }
})
