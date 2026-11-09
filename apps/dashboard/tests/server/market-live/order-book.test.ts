// Seam (a) of spec apinrdw/kumora#138, for the order book: Stockbit
// `order_book` frames and Ajaib `ORDER_BOOK_CUSTOM` frames go in through the
// ingest socket, time moves only by TestClock, and the test reads the books
// viewers receive.
import { assert, describe, it } from "@effect/vitest"
import {
  IngestProtocolVersion,
  StockCode,
  ViewerProtocolVersion,
  WibDate,
  decodeViewerDown,
  encodeIngestUp,
  encodeViewerUp,
  type OrderBook,
  type ViewerDown,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"

import { makeOrderBooks } from "@/server/market-live/order-books"
import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "@/server/market-live/trading-day"

import recorded from "./fixtures/order-books-2026-11-09.json"
import { memorySql } from "./sql"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-09")

class FakeSocket implements Peer {
  readonly sent: Array<string> = []
  private current: PeerState = "new"
  send = (text: string) => Effect.sync(() => void this.sent.push(text))
  close = () => Effect.void
  state = Effect.sync(() => this.current)
  setState = (state: PeerState) =>
    Effect.sync(() => {
      this.current = state
    })
}

const env = Layer.succeed(WorkerEnv)(
  // Only the binding the object reads.
  { INGEST_TOKEN: TOKEN } as unknown as WorkerEnv["Service"]
)

const varint = (value: number): Array<number> => {
  const bytes: Array<number> = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return bytes
}
const varintField = (field: number, value: number) => [
  ...varint(field * 8),
  ...varint(value),
]
const doubleField = (field: number, value: number) => {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, value, true)
  return [...varint(field * 8 + 1), ...bytes]
}
const messageField = (field: number, bytes: ReadonlyArray<number>) => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
]
const stringField = (field: number, text: string) =>
  messageField(field, [...new TextEncoder().encode(text)])

// Wrapper case 10, `Orderbook`: the stock code, the pipe-delimited body of
// one side, and the frame's ISO time.
const orderBookFrame = (code: string, body: string, datetime: string) =>
  Uint8Array.from(
    messageField(10, [
      ...stringField(1, code),
      ...stringField(2, body),
      ...stringField(5, datetime),
    ])
  )

// Wrapper case 9, `LivePrice`, with the previous close and the index flag.
const livePriceFrame = (row: {
  readonly code: string
  readonly previous: number
  readonly isIndex?: boolean
}) =>
  Uint8Array.from(
    messageField(9, [
      ...stringField(1, row.code),
      ...doubleField(2, row.previous),
      ...stringField(11, recorded.stockbit.bbca.datetime),
      ...doubleField(13, row.previous),
      ...(row.isIndex === true ? varintField(18, 1) : []),
    ])
  )

// 14:20:26 WIB, session 2: when the recorded books were seen.
const SEEN = Date.parse(recorded.stockbit.bbca.datetime)

const tradingDay = Effect.fnUntraced(function* () {
  yield* TestClock.setTime(SEEN)
  const viewers: Array<FakeSocket> = []
  const scope = yield* Scope.make()
  const day = yield* makeTradingDay({
    sql: memorySql(),
    date: DAY,
    viewers: Effect.sync(() => viewers),
    viewersOf: () => Effect.succeed([]),
  }).pipe(Scope.provide(scope))
  const ingest = (socket: FakeSocket, text: string) =>
    day.ingestMessage(socket, text).pipe(Effect.provide(env))
  const relay = new FakeSocket()
  yield* ingest(
    relay,
    yield* encodeIngestUp({
      _tag: "Token",
      protocolVersion: IngestProtocolVersion,
      token: TOKEN,
    })
  )
  const receivedAt = DateTime.makeUnsafe(SEEN)
  const stockbit = Effect.fnUntraced(function* (
    frames: ReadonlyArray<Uint8Array>
  ) {
    yield* ingest(
      relay,
      yield* encodeIngestUp({
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Stockbit",
        connection: "A",
        receivedAt,
        frames,
      })
    )
  })
  const ajaib = Effect.fnUntraced(function* (frames: ReadonlyArray<string>) {
    yield* ingest(
      relay,
      yield* encodeIngestUp({
        _tag: "Frames",
        protocolVersion: IngestProtocolVersion,
        feed: "Ajaib",
        connection: "A",
        receivedAt,
        frames,
      })
    )
  })
  const viewer = Effect.fnUntraced(function* (selected: string) {
    const socket = new FakeSocket()
    viewers.push(socket)
    yield* day.viewerMessage(
      socket,
      yield* encodeViewerUp({
        _tag: "Select",
        protocolVersion: ViewerProtocolVersion,
        selected: StockCode.make(selected),
        watchlist: [],
      })
    )
    return socket
  })
  return { stockbit, ajaib, viewer }
})

const received = (socket: FakeSocket) =>
  Effect.forEach(socket.sent, (text) => decodeViewerDown(text))

const snapshotBook = (messages: ReadonlyArray<ViewerDown>) => {
  const [snapshot] = messages
  return snapshot?._tag === "Snapshot" ? snapshot.orderBook : undefined
}

// The books every delta carried for `code`, in order.
const deltaBooks = (messages: ReadonlyArray<ViewerDown>, code: string) =>
  messages.flatMap((message) =>
    message._tag === "Delta"
      ? (message.orderBooks ?? []).filter((book) => book.code === code)
      : []
  )

const top = (book: OrderBook, levels = 3) => ({
  provenance: book.provenance,
  bids: book.bids.slice(0, levels),
  offers: book.offers.slice(0, levels),
})

const { bbca } = recorded.stockbit
const BBCA_SIDES = [
  orderBookFrame("BBCA", bbca.bid, bbca.datetime),
  orderBookFrame("BBCA", bbca.offer, bbca.datetime),
]

describe("the order book", () => {
  it.effect(
    "the selected code's Stockbit book is in its snapshot, 20 levels a side, best first",
    () =>
      Effect.gen(function* () {
        const { stockbit, viewer } = yield* tradingDay()
        yield* stockbit([
          livePriceFrame({ code: "BBCA", previous: 5025 }),
          ...BBCA_SIDES,
        ])
        const book = snapshotBook(yield* received(yield* viewer("BBCA")))
        assert(book?._tag === "OrderBook")
        assert.deepStrictEqual(top(book), {
          provenance: "Stockbit",
          bids: [
            { price: 5025, lots: 36_009, orders: 193 },
            { price: 5000, lots: 28_935, orders: 348 },
            { price: 4990, lots: 30_547, orders: 1087 },
          ],
          // The book's zero-lot levels at 5000 and 5025 aren't offers.
          offers: [
            { price: 5050, lots: 14_151, orders: 77 },
            { price: 5075, lots: 50_029, orders: 208 },
            { price: 5100, lots: 43_693, orders: 625 },
          ],
        })
        assert.strictEqual(book.bids.length, 20)
        assert.strictEqual(book.offers.length, 20)
        // The whole side, beyond the 20 levels sent.
        assert.isAbove(
          book.offerLots,
          book.offers.reduce((sum, level) => sum + level.lots, 0)
        )
        assert.strictEqual(book.previousClose, 5025)
        assert.strictEqual(DateTime.toEpochMillis(book.at), SEEN)
      })
  )

  it.effect("a code with no order book frame yet has none", () =>
    Effect.gen(function* () {
      const { stockbit, viewer } = yield* tradingDay()
      yield* stockbit(BBCA_SIDES)
      assert.isUndefined(snapshotBook(yield* received(yield* viewer("TLKM"))))
    })
  )

  it.effect("an index has no order book", () =>
    Effect.gen(function* () {
      const { stockbit, viewer } = yield* tradingDay()
      yield* stockbit([
        livePriceFrame({ code: "IHSG", previous: 4980, isIndex: true }),
      ])
      assert.deepStrictEqual(
        snapshotBook(yield* received(yield* viewer("IHSG"))),
        { _tag: "IndexHasNoBook", code: StockCode.make("IHSG") }
      )
    })
  )

  it.effect(
    "while Stockbit is live, Ajaib's book changes nothing viewers see",
    () =>
      Effect.gen(function* () {
        const { stockbit, ajaib, viewer } = yield* tradingDay()
        yield* stockbit(BBCA_SIDES)
        const page = yield* viewer("BBCA")
        yield* ajaib(recorded.ajaib.bbca)
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(
          deltaBooks(yield* received(page), "BBCA").map(
            (book) => book.provenance
          ),
          ["Stockbit"]
        )
      })
  )

  it.effect(
    "while Stockbit is stale, Ajaib's book is served, its deltas applied, and Stockbit's returns with its next frame",
    () =>
      Effect.gen(function* () {
        const { stockbit, ajaib, viewer } = yield* tradingDay()
        yield* stockbit(BBCA_SIDES)
        const page = yield* viewer("BBCA")
        // 15 s with no Stockbit frame: stale.
        yield* TestClock.adjust("16 seconds")
        // The snapshot, then deltas: 4990 rises to 30,548 lots, 4900 falls.
        yield* ajaib(recorded.ajaib.bbca)
        yield* TestClock.adjust("1 second")
        const fallback = deltaBooks(yield* received(page), "BBCA").find(
          (book) => book.provenance === "Ajaib"
        )
        assert(fallback !== undefined)
        assert.deepStrictEqual(top(fallback), {
          provenance: "Ajaib",
          bids: [
            { price: 5025, lots: 36_009, orders: 193 },
            { price: 5000, lots: 28_935, orders: 348 },
            { price: 4990, lots: 30_548, orders: 1088 },
          ],
          offers: [
            { price: 5050, lots: 14_151, orders: 77 },
            { price: 5075, lots: 50_029, orders: 208 },
            { price: 5100, lots: 43_693, orders: 625 },
          ],
        })
        assert.deepStrictEqual(
          fallback.bids.find((level) => level.price === 4900),
          { price: 4900, lots: 53_926, orders: 1006 }
        )
        // A viewer selecting it now starts from the fallback too.
        const late = snapshotBook(yield* received(yield* viewer("BBCA")))
        assert.strictEqual(
          late?._tag === "OrderBook" ? late.provenance : undefined,
          "Ajaib"
        )
        yield* stockbit(BBCA_SIDES)
        yield* TestClock.adjust("1 second")
        const books = deltaBooks(yield* received(page), "BBCA")
        assert.deepStrictEqual(
          books.map((book) => book.provenance),
          ["Stockbit", "Ajaib", "Stockbit"]
        )
      })
  )
})

// One whole websocket frame, `orderbook` (wrapper case 10) holding PRDL's bid
// side, captured from wss-jkt.trading.stockbit.com on 2026-07-29 (09:51:01
// WIB). Not a seam: the decoder alone, which the spec allows Vitest for.
const PRDL_BID =
  "Uu0BCgRQUkRMEpUBI098UFJETHxCSUR8MjUyOzU4OzU4NjYwMHwyNTA7MTQ0OzEwODg3MDB8MjQ4OzM0OzIwNjQwMHwyNDY7MTk7MTU3MDAwfDI0NDsyMTsxMjE4MDB8MjQyOzI2OzUyMDIwMHwyNDA7NDk7OTUzOTAwfDIzODs2OTsyMzc1MjAwfDE3ODUyOTM0NjEtNDIwJjYwMDk4MDAY0FAgpVkqIDIwMjYtMDctMjlUMDk6NTE6MDEuMzIzNDU0KzA3OjAwQAFKIzIwMjYtMDctMjlUMDk6NTE6MDEuMzI0NTI1OTIzKzA3OjAw"

describe("Ajaib's ORDER_BOOK_CUSTOM frames", () => {
  // 09:00:ss WIB, as `updateTime` carries it.
  const at = (seconds: number) => Date.UTC(2026, 10, 9, 2, 0, seconds)
  const frame = (
    updateTime: number,
    buy: ReadonlyArray<{ price: number; lot: number; num: number }>,
    initial = false
  ) =>
    JSON.stringify({
      ticker: "BBCA",
      ...(initial ? { is_initial: "true" } : {}),
      buy,
      sell: [],
      updateTime,
    })

  it.effect(
    "a frame older than the book's last, as the other connection delivers one late, changes nothing",
    () =>
      Effect.gen(function* () {
        const books = yield* makeOrderBooks(DAY)
        yield* books.ajaibFrames([
          frame(at(0), [{ price: 5000, lot: 10, num: 1 }], true),
          frame(at(2), [{ price: 5000, lot: 30, num: 3 }]),
        ])
        // Connection B: the delta A already applied over, then an older
        // snapshot.
        yield* books.ajaibFrames([
          frame(at(1), [{ price: 5000, lot: 20, num: 2 }]),
          frame(at(1), [{ price: 4900, lot: 5, num: 1 }], true),
        ])
        const book = yield* books.bookOf(StockCode.make("BBCA"), false)
        assert(book?._tag === "OrderBook")
        assert.deepStrictEqual(
          { bids: book.bids, at: DateTime.toEpochMillis(book.at) },
          { bids: [{ price: 5000, lots: 30, orders: 3 }], at: at(2) }
        )
      })
  )
})

describe("Stockbit's order_book frames", () => {
  it.effect("decode one side: levels in lots, the side's total lots", () =>
    Effect.gen(function* () {
      const books = yield* makeOrderBooks(WibDate.make("2026-07-29"))
      yield* books.stockbitFrames([
        Uint8Array.from(atob(PRDL_BID), (char) => char.charCodeAt(0)),
      ])
      const book = yield* books.bookOf(StockCode.make("PRDL"), true)
      assert(book?._tag === "OrderBook")
      assert.deepStrictEqual(
        {
          bids: book.bids.slice(0, 2),
          levels: book.bids.length,
          bidLots: book.bidLots,
          offers: book.offers,
          at: DateTime.formatIso(book.at),
        },
        {
          bids: [
            { price: 252, lots: 5866, orders: 58 },
            { price: 250, lots: 10_887, orders: 144 },
          ],
          levels: 8,
          bidLots: 60_098,
          // No offer frame yet.
          offers: [],
          at: "2026-07-29T02:51:01.323Z",
        }
      )
    })
  )

  // One side's body: a single level, and the side's totals.
  const body = (side: "BID" | "OFFER", price: number, lots: number) =>
    `#O|BBCA|${side}|${price};1;${lots * 100}|1762653661-1&${lots * 100}`
  // 09:01:0s WIB, as `datetime` carries it.
  const at = (second: number) => `2026-11-09T09:01:0${second}+07:00`

  it.effect(
    "a side's frame not newer than the side held, as the other connection delivers one late, changes nothing; the other side still applies",
    () =>
      Effect.gen(function* () {
        const books = yield* makeOrderBooks(DAY)
        yield* books.stockbitFrames([
          orderBookFrame("BBCA", body("BID", 5000, 10), at(2)),
        ])
        // Connection B: an older bid, and the offer side the book lacks.
        yield* books.stockbitFrames([
          orderBookFrame("BBCA", body("BID", 4900, 5), at(1)),
          orderBookFrame("BBCA", body("OFFER", 5100, 7), at(1)),
        ])
        const book = yield* books.bookOf(StockCode.make("BBCA"), true)
        assert(book?._tag === "OrderBook")
        assert.deepStrictEqual(
          {
            bids: book.bids,
            offers: book.offers,
            at: DateTime.toEpochMillis(book.at),
          },
          {
            bids: [{ price: 5000, lots: 10, orders: 1 }],
            offers: [{ price: 5100, lots: 7, orders: 1 }],
            at: Date.parse(at(2)),
          }
        )
      })
  )

  it.effect("skip a frame from another trading day", () =>
    Effect.gen(function* () {
      const books = yield* makeOrderBooks(WibDate.make("2026-07-30"))
      yield* books.stockbitFrames([
        Uint8Array.from(atob(PRDL_BID), (char) => char.charCodeAt(0)),
      ])
      assert.isUndefined(yield* books.bookOf(StockCode.make("PRDL"), true))
    })
  )
})
