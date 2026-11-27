// A trading day driven through its Durable Object interface, for the order
// flow tests (spec apinrdw/kumora#263): fake sockets, Node's SQLite, and
// Stockbit running trade batches. Time moves only by TestClock: a delta goes
// out 250 ms after what it carries arrived, a flush 5 s past each minute.
import { gunzipSync } from "node:zlib"

import {
  BrokerCode,
  HEAT_SLICE_MS,
  BrokerCodesProtocolVersion,
  IngestProtocolVersion,
  StockCode,
  OrderNumber,
  TradeNumber,
  ViewerProtocolVersion,
  WibDate,
  decodeRecordedCandles,
  decodeRecordedSweepBrokers,
  decodeRecordedSweeps,
  decodeViewerDown,
  encodeBrokerCodesBatch,
  encodeIngestUp,
  encodeViewerUp,
  type Feed,
  type Footprint,
  type RecordedResource,
  type Sweep,
  type TradeFields,
  type ViewerDown,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import {
  DateTime,
  Effect,
  Exit,
  Layer,
  Logger,
  References,
  Scope,
} from "effect"
import { TestClock } from "effect/testing"

import type { BrokerTotalsDb } from "@/server/broker-totals/db"
import type { DayBucket } from "@/server/market-live/cold-bucket"
import type { Sql } from "@/server/market-live/day-store"
import { chunkSlices, heldChunkOf } from "@/server/market-live/heat-rows"
import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "@/server/market-live/trading-day"

import {
  messageField,
  runningTradeBatch,
  stringField,
  type StockbitRow,
} from "./protobuf"
import { memorySql } from "./sql"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-09")

class FakeSocket implements Peer {
  open = Effect.succeed(true)
  readonly sent: Array<string> = []
  closedWith: number | undefined
  private current: PeerState = "new"
  private codes: ReadonlyArray<StockCode> = []
  send = (text: string) => Effect.sync(() => void this.sent.push(text))
  close = (code: number) =>
    Effect.sync(() => {
      this.closedWith = code
    })
  state = Effect.sync(() => this.current)
  setState = (state: PeerState) =>
    Effect.sync(() => {
      this.current = state
    })
  watching = Effect.sync(() => this.codes)
  setWatching = (codes: ReadonlyArray<StockCode>) =>
    Effect.sync(() => {
      this.codes = codes
    })
  // Every viewer message received so far, decoded.
  received = Effect.suspend(() =>
    Effect.forEach(this.sent, (text) => decodeViewerDown(text))
  )
}

const env = Layer.succeed(WorkerEnv)(
  // Only the binding the object reads.
  { INGEST_TOKEN: TOKEN } as unknown as WorkerEnv["Service"]
)

// A Stockbit running trade on 2026-11-09. `side` undefined sends no action,
// as the auction match prints carry none.
export const stockbitTrade = (trade: {
  readonly number: number
  readonly time: string
  readonly code?: string
  readonly price: number
  readonly lots: number
  readonly side?: "buy" | "sell"
  readonly board?: "RG" | "TN" | "NG"
}): StockbitRow => ({
  tradeWib: trade.time,
  code: trade.code ?? "UNTR",
  price: trade.price,
  volume: trade.lots * 100,
  ...(trade.side === undefined ? {} : { action: trade.side === "buy" ? 1 : 2 }),
  board: trade.board === "TN" ? 2 : trade.board === "NG" ? 3 : 1,
  tradeNumber: trade.number,
})

// Ajaib's copy of a running trade on 2026-11-09, as its trade stream frames
// it: a whole-second time and a BUY or SELL type.
export const ajaibTrade = (trade: {
  readonly number: number
  readonly time: string
  readonly code?: string
  readonly price: number
  readonly lots: number
  readonly side: "buy" | "sell"
}) =>
  JSON.stringify({
    ticker: trade.code ?? "UNTR",
    type: trade.side === "buy" ? "BUY" : "SELL",
    price: trade.price,
    lot: trade.lots,
    tradedAt: `2026-11-09T${trade.time}+07:00`,
    tradeNum: `20261109${String(trade.number).padStart(10, "0")}`,
  })

// Stockbit's `order_book` frame (wrapper case 10) of one full side of
// `code`'s book on 2026-11-09, as of `time` (WIB). Levels are [price, orders,
// lots], best first.
export const stockbitBook = (book: {
  readonly code?: string
  readonly side: "BID" | "OFFER"
  readonly levels: ReadonlyArray<
    readonly [price: number, orders: number, lots: number]
  >
  readonly time: string
}) => {
  const code = book.code ?? "UNTR"
  const shares = book.levels.reduce((sum, [, , lots]) => sum + lots * 100, 0)
  const body = [
    "#O",
    code,
    book.side,
    ...book.levels.map(
      ([price, orders, lots]) => `${price};${orders};${lots * 100}`
    ),
    `0-${book.levels.length}&${shares}`,
  ].join("|")
  return Uint8Array.from(
    messageField(10, [
      ...stringField(1, code),
      ...stringField(2, body),
      ...stringField(5, `2026-11-09T${book.time}+07:00`),
    ])
  )
}

// A trading day on `sql` (a fresh database by default; the same one again is
// the object restarting, and its `viewers` again the sockets that outlived
// it), with a relay that sent the right token. Its builds write to
// `brokerTotalsDb` when given, and `alarms` lists every instant it set the
// alarm for. Given `cold`, it moves to its bucket: emptying the object drops
// every table of `sql`, and `asked` lists the days it asked to move: each
// day `listed` answers true for, every day when it is left out.
export const tradingDay = Effect.fnUntraced(function* (
  sql: Sql = memorySql(),
  viewers: Array<FakeSocket> = [],
  brokerTotalsDb?: Layer.Layer<BrokerTotalsDb>,
  cold?: {
    readonly bucket: Effect.Effect<DayBucket>
    readonly markCold: Effect.Effect<void, unknown>
    readonly listed?: (date: WibDate) => Effect.Effect<boolean, unknown>
  }
) {
  const scope = yield* Scope.make()
  const alarms: Array<DateTime.Utc> = []
  const asked: Array<WibDate> = []
  let emptied = false
  const day = yield* makeTradingDay({
    sql,
    date: DAY,
    viewers: Effect.sync(() => viewers),
    viewersOf: () => Effect.succeed([]),
    setAlarm: (at) => Effect.sync(() => void alarms.push(at)),
    ...(brokerTotalsDb === undefined ? {} : { brokerTotalsDb }),
    ...(cold === undefined
      ? {}
      : {
          cold: {
            listed: () => Effect.succeed(true),
            ...cold,
            empty: Effect.sync(() => {
              for (const { name } of sql.exec(
                "SELECT name FROM sqlite_schema WHERE type = 'table'"
              ))
                sql.exec(`DROP TABLE "${String(name)}"`)
              emptied = true
            }),
            askMove: (date: WibDate) =>
              Effect.sync(() => void asked.push(date)),
          },
        }),
  }).pipe(Scope.provide(scope))
  const relay = new FakeSocket()
  const ingest = (text: string) =>
    day.ingestMessage(relay, text).pipe(Effect.provide(env))
  yield* ingest(
    yield* encodeIngestUp({
      _tag: "Token",
      protocolVersion: IngestProtocolVersion,
      token: TOKEN,
    })
  )
  // Stockbit's running trades, in one envelope.
  const trades = Effect.fnUntraced(function* (
    rows: ReadonlyArray<StockbitRow>
  ) {
    yield* ingest(
      yield* encodeIngestUp({
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Stockbit",
        connection: "A",
        receivedAt: DateTime.makeUnsafe("2026-11-09T02:00:01.000Z"),
        frames: [runningTradeBatch(rows)],
      })
    )
  })
  // Ajaib's running trades, in one envelope of its trade stream.
  const ajaibTrades = Effect.fnUntraced(function* (
    sent: ReadonlyArray<string>
  ) {
    yield* ingest(
      yield* encodeIngestUp({
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Ajaib",
        stream: "trade",
        connection: "A",
        receivedAt: DateTime.makeUnsafe("2026-11-09T02:00:01.000Z"),
        frames: sent,
      })
    )
  })
  // Stockbit frames other than running trades, received now.
  const frames = Effect.fnUntraced(function* (sent: ReadonlyArray<Uint8Array>) {
    yield* ingest(
      yield* encodeIngestUp({
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Stockbit",
        connection: "A",
        receivedAt: yield* DateTime.now,
        frames: sent,
      })
    )
  })
  // Ajaib's code list response `body`, as the relay sends it.
  const codeList = Effect.fnUntraced(function* (body: string) {
    yield* ingest(
      yield* encodeIngestUp({
        _tag: "CodeList",
        protocolVersion: IngestProtocolVersion,
        receivedAt: yield* DateTime.now,
        body,
      })
    )
  })
  // A viewer that selected `code` and watches `watchlist`, and so was sent a
  // snapshot.
  const viewer = Effect.fnUntraced(function* (
    code: string,
    protocolVersion: number = ViewerProtocolVersion,
    watchlist: ReadonlyArray<string> = []
  ) {
    const socket = new FakeSocket()
    viewers.push(socket)
    const text = yield* encodeViewerUp({
      _tag: "Select",
      protocolVersion: ViewerProtocolVersion,
      selected: StockCode.make(code),
      watchlist: watchlist.map((watched) => StockCode.make(watched)),
    })
    yield* day.viewerMessage(
      socket,
      text.replace(
        `"protocolVersion":${ViewerProtocolVersion}`,
        `"protocolVersion":${protocolVersion}`
      )
    )
    return socket
  })
  // A viewer's socket closed: the object stops sending it deltas, and with
  // no viewer left, stops its delta timer.
  const left = Effect.fnUntraced(function* (socket: FakeSocket) {
    viewers.splice(viewers.indexOf(socket), 1)
    yield* day.viewerClosed(socket)
  })
  const recorded = (resource: RecordedResource) =>
    day.recorded(resource).pipe(Effect.provide(env))
  // The broker codes status GET's answer, with the GET's query.
  const status = (search = "") =>
    day.brokerCodes
      .status(new URLSearchParams(search))
      .pipe(Effect.provide(env))
  // The held order numbers GET's answer, with the GET's query.
  const orderNumbers = (search = "") =>
    day.brokerCodes
      .orderNumbers(new URLSearchParams(search))
      .pipe(Effect.provide(env))
  // A code's recorded day candles answer, decoded, with its Cache-Control.
  const recordedCandles = Effect.fnUntraced(function* (code: string) {
    const response = yield* recorded({
      _tag: "Candles",
      code: StockCode.make(code),
    })
    const text = yield* Effect.promise(() => response.text())
    return {
      cacheControl: response.headers.get("Cache-Control"),
      answer: yield* decodeRecordedCandles(text),
    }
  })
  // A code's sweeps answer, decoded, with its Cache-Control.
  const recordedSweeps = Effect.fnUntraced(function* (code: string) {
    const response = yield* recorded({
      _tag: "Sweeps",
      code: StockCode.make(code),
    })
    const text = yield* Effect.promise(() => response.text())
    return {
      cacheControl: response.headers.get("Cache-Control"),
      answer: yield* decodeRecordedSweeps(text),
    }
  })
  // A code's sweep brokers answer, decoded, with its Cache-Control.
  const recordedSweepBrokers = Effect.fnUntraced(function* (code: string) {
    const response = yield* recorded({
      _tag: "SweepBrokers",
      code: StockCode.make(code),
    })
    const text = yield* Effect.promise(() => response.text())
    return {
      cacheControl: response.headers.get("Cache-Control"),
      answer: yield* decodeRecordedSweepBrokers(text),
    }
  })
  // A broker codes batch of the day from `feed`, as the Worker hands it over,
  // each row [trade number, "AK F CD D"]: buyer and type, seller and type,
  // and its fields when given; a row without them posts its codes alone. A
  // row's order numbers [buy, sell] follow its fields, null for none.
  const brokerCodes = Effect.fnUntraced(function* (
    feed: Feed,
    rows: ReadonlyArray<
      | readonly [number, string]
      | readonly [number, string, TradeFields]
      | readonly [number, string, TradeFields | null, readonly [number, number]]
    >,
    end?: number
  ) {
    const response = yield* day.brokerCodes.post(
      yield* encodeBrokerCodesBatch({
        version: BrokerCodesProtocolVersion,
        feed,
        day: DAY,
        rows: rows.map(([number, text, fields, orders]) => {
          const [buyer, buyerType, seller, sellerType] = text.split(" ")
          const codes = {
            buyer: BrokerCode.make(buyer!),
            buyerType: buyerType === "F" ? ("F" as const) : ("D" as const),
            seller: BrokerCode.make(seller!),
            sellerType: sellerType === "F" ? ("F" as const) : ("D" as const),
          }
          const tradeNumber = TradeNumber.make(String(number))
          if (orders !== undefined)
            return [
              tradeNumber,
              codes,
              fields ?? null,
              [OrderNumber.make(orders[0]), OrderNumber.make(orders[1])],
            ] as const
          return fields === undefined || fields === null
            ? ([tradeNumber, codes] as const)
            : ([tradeNumber, codes, fields] as const)
        }),
        ...(end === undefined
          ? {}
          : { end: { n: TradeNumber.make(String(end)) } }),
      })
    )
    if (response.status !== 200)
      return yield* Effect.die(`Batch answered ${response.status}`)
  })
  return {
    day,
    trades,
    brokerCodes,
    recordedSweepBrokers,
    ajaibTrades,
    frames,
    codeList,
    viewers,
    viewer,
    left,
    recorded,
    status,
    orderNumbers,
    recordedCandles,
    recordedSweeps,
    alarm: day.alarm.pipe(Effect.provide(env)),
    alarms,
    asked,
    // The day's answer to the next trading day's ask for its values.
    dayValues: day.dayValues.pipe(Effect.provide(env)),
    // Whether the move emptied the object.
    emptied: Effect.sync(() => emptied),
    // A newer day's seal or the reconcile cron asking it to move.
    move: day.move.pipe(Effect.provide(env)),
    // At midnight ten trading days on, out of the window, the day asked to
    // move and its alarm run while a step is due: whether it emptied.
    movedToR2: Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T00:00:00+07:00"))
      )
      if (!(yield* day.move)) return false
      for (let run = 0; run < 50 && !emptied; run++) {
        const due = alarms.at(-1)
        if (
          due === undefined ||
          DateTime.isGreaterThan(due, yield* DateTime.now)
        )
          break
        yield* day.alarm.pipe(Effect.provide(env))
      }
      return emptied
    }),
    // The reconcile cron's poke: whether the day will build.
    reconcile: day.brokerTotals.reconcile,
    // The object evicted: its timers stop, so the clock can move days on.
    evicted: Scope.close(scope, Exit.void),
  }
})

// What a day sealed before order flow shipped holds: no footprint or heatmap
// table, and no mark that its rows were built.
export const sealedBeforeOrderFlow = (sql: Sql) =>
  Effect.sync(() => {
    sql.exec("DROP TABLE footprints")
    sql.exec("DROP TABLE heatmaps")
    sql.exec("DELETE FROM facts WHERE key = 'order-flow-built'")
  })

// What a day recorded before heatmaps were worked out on read holds: a
// heatmap row beside each book chunk before `until`, its slices as the chunk
// close wrote them ([slice index, levels] for each slice with lots).
export const heatmapRowsBeforeOnRead = (sql: Sql, until = Infinity) =>
  Effect.forEach(
    sql.exec("SELECT code, minute, chunk FROM book_chunks ORDER BY minute"),
    Effect.fnUntraced(function* (row) {
      const minute = Number(row.minute)
      if (minute >= until) return
      const chunk = yield* heldChunkOf(
        gunzipSync(row.chunk as Uint8Array).toString()
      )
      const slices = yield* chunkSlices(chunk)
      sql.exec(
        "INSERT INTO heatmaps VALUES (?, ?, ?)",
        String(row.code),
        minute,
        JSON.stringify(
          slices.map((slice) => [
            (DateTime.toEpochMillis(slice.at) - minute) / HEAT_SLICE_MS,
            slice.levels,
          ])
        )
      )
    }),
    { discard: true }
  )

// What a day whose codes landed before sweep brokers shipped holds: no sweep
// brokers rows, and no mark that they were built.
export const codesBeforeSweepBrokers = (sql: Sql) =>
  Effect.sync(() => {
    sql.exec("DELETE FROM sweep_brokers")
    sql.exec("DELETE FROM facts WHERE key = 'sweep-brokers-built'")
  })

// The footprints a viewer was sent of `code`, snapshot and deltas in order.
export const footprintsOf = (
  messages: ReadonlyArray<ViewerDown>,
  code: string
): ReadonlyArray<Footprint> =>
  messages.flatMap((message) =>
    (message.footprints ?? []).filter((footprint) => footprint.code === code)
  )

// A footprint as a test compares it: its minute in ISO, and its cells
// ascending by price as [price, sell, buy, none].
export const cellsOf = (footprint: Footprint | undefined) =>
  footprint && {
    minute: DateTime.formatIso(footprint.minute),
    cells: footprint.cells.map((cell) => [
      cell.price,
      cell.sell,
      cell.buy,
      cell.none,
    ]),
  }

// A sweep as a test compares it: [side, time in ISO, first, last, lots,
// trades].
export const sweepOf = (sweep: Sweep) => [
  sweep.side,
  DateTime.formatIso(sweep.time),
  sweep.first,
  sweep.last,
  sweep.lots,
  sweep.trades,
]

// A logged line's annotations.
export type Line = Readonly<Record<string, unknown>>

// Runs `test` with the annotations of every line logged with `message`.
export const withLines = <A, E, R>(
  message: string,
  test: (lines: ReadonlyArray<Line>) => Effect.Effect<A, E, R>
) => {
  const lines: Array<Line> = []
  const capture = Logger.make(({ message: logged, fiber }) => {
    const [text] = Array.isArray(logged) ? logged : [logged]
    if (text === message)
      lines.push(fiber.getRef(References.CurrentLogAnnotations) as Line)
  })
  return test(lines).pipe(Effect.provide(Logger.layer([capture])))
}
