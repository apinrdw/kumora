// A trading day driven through its Durable Object interface, for the order
// flow tests (spec apinrdw/kumora#263): fake sockets, Node's SQLite, and
// Stockbit running trade batches. Time moves only by TestClock: a delta goes
// out 250 ms after what it carries arrived, a flush 5 s past each minute.
import {
  IngestProtocolVersion,
  StockCode,
  ViewerProtocolVersion,
  WibDate,
  decodeRecordedCandles,
  decodeRecordedSweeps,
  decodeViewerDown,
  encodeIngestUp,
  encodeViewerUp,
  type Footprint,
  type RecordedResource,
  type Sweep,
  type ViewerDown,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Scope } from "effect"

import type { Sql } from "@/server/market-live/day-store"
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
// the object restarting), with a relay that sent the right token.
export const tradingDay = Effect.fnUntraced(function* (sql: Sql = memorySql()) {
  const viewers: Array<FakeSocket> = []
  const scope = yield* Scope.make()
  const day = yield* makeTradingDay({
    sql,
    date: DAY,
    viewers: Effect.sync(() => viewers),
    viewersOf: () => Effect.succeed([]),
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
  // A viewer that selected `code`, and so was sent a snapshot.
  const viewer = Effect.fnUntraced(function* (
    code: string,
    protocolVersion: number = ViewerProtocolVersion
  ) {
    const socket = new FakeSocket()
    viewers.push(socket)
    const text = yield* encodeViewerUp({
      _tag: "Select",
      protocolVersion: ViewerProtocolVersion,
      selected: StockCode.make(code),
      watchlist: [],
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
  const recorded = (resource: RecordedResource) =>
    day.recorded(resource).pipe(Effect.provide(env))
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
  return {
    day,
    trades,
    frames,
    viewer,
    recorded,
    recordedCandles,
    recordedSweeps,
    alarm: day.alarm.pipe(Effect.provide(env)),
  }
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
