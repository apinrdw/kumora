// Seam (a) of spec apinrdw/kumora#138, for Day state and the Ajaib on-demand
// codes: recorded Stockbit `liveprice` and Ajaib `PRICE` frames go in through
// the ingest socket, time moves only by TestClock, and the test reads the
// Day states viewers receive and what the relay is sent.
import { assert, describe, it } from "@effect/vitest"
import {
  IngestProtocolVersion,
  StockCode,
  ViewerProtocolVersion,
  WibDate,
  decodeIngestDown,
  decodeViewerDown,
  encodeIngestUp,
  encodeViewerUp,
  type DayState,
  type ViewerDown,
} from "@workspace/relay"
import { WorkerEnv } from "@workspace/server"
import { DateTime, Effect, Layer, Scope } from "effect"
import { TestClock } from "effect/testing"

import {
  makeTradingDay,
  type Peer,
  type PeerState,
} from "@/server/market-live/trading-day"

import recordedPrice from "./fixtures/ajaib-price-2026-11-06.json"
import recordedTrades from "./fixtures/ajaib-trades-2026-11-09.json"
import recordedIhsg from "./fixtures/stockbit-ihsg-liveprice.json"
import recordedLivePrice from "./fixtures/stockbit-liveprice-2026-11-09.json"
import {
  doubleField,
  messageField,
  runningTradeBatch,
  stringField,
  varintField,
  type StockbitRow,
} from "./protobuf"
import { memorySql } from "./sql"
import { everySplit } from "../../interleaved"

const TOKEN = "e2e-ingest-token"
const DAY = WibDate.make("2026-11-09")

class FakeSocket implements Peer {
  open = Effect.succeed(true)
  readonly sent: Array<string> = []
  private current: PeerState = "new"
  private codes: ReadonlyArray<StockCode> = []
  send = (text: string) => Effect.sync(() => void this.sent.push(text))
  close = () => Effect.void
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
}

const env = Layer.succeed(WorkerEnv)(
  // Only the binding the object reads.
  { INGEST_TOKEN: TOKEN } as unknown as WorkerEnv["Service"]
)

// The recorded `liveprice` rows: 09:51:01 WIB, in session 1.
interface LivePriceRow {
  readonly code: string
  readonly date: string
  readonly last: number
  readonly volume: number
  readonly high: number
  readonly low: number
  readonly open: number
  readonly frequency: number
  readonly prev: number
  readonly value: number
  readonly change: number
  readonly changePercent: number
  readonly board: number
}
const LIVE_PRICES: ReadonlyArray<LivePriceRow> = recordedLivePrice.rows
const BBRI = LIVE_PRICES.find((row) => row.code === "BBRI")!
const TINS = LIVE_PRICES.find((row) => row.code === "TINS")!

// One `liveprice` frame, encoded back into wrapper case 9 by `LivePrice`'s
// field numbers.
const livePriceFrame = (row: LivePriceRow) =>
  Uint8Array.from(
    messageField(9, [
      ...stringField(1, row.code),
      ...doubleField(2, row.last),
      ...doubleField(3, row.volume),
      ...doubleField(4, row.high),
      ...doubleField(5, row.low),
      ...doubleField(6, row.open),
      ...doubleField(7, row.frequency),
      ...stringField(11, row.date),
      ...doubleField(13, row.prev),
      ...doubleField(14, row.value),
      ...messageField(15, [
        ...doubleField(1, row.change),
        ...doubleField(2, row.changePercent),
      ]),
      ...varintField(23, row.board),
    ])
  )

// IHSG's recorded `liveprice` frames: an index's carry no previous close, no
// change and no board, and some only the totals.
interface IndexRow {
  readonly code: string
  readonly date: string
  readonly last?: number
  readonly volume: number
  readonly high?: number
  readonly low?: number
  readonly open?: number
  readonly frequency: number
  readonly value: number
}
const optionalDouble = (field: number, value: number | undefined) =>
  value === undefined ? [] : doubleField(field, value)
const indexFrame = (row: IndexRow) =>
  Uint8Array.from(
    messageField(9, [
      ...stringField(1, row.code),
      ...optionalDouble(2, row.last),
      ...doubleField(3, row.volume),
      ...optionalDouble(4, row.high),
      ...optionalDouble(5, row.low),
      ...optionalDouble(6, row.open),
      ...doubleField(7, row.frequency),
      ...stringField(11, row.date),
      ...doubleField(14, row.value),
      ...varintField(18, 1),
    ])
  )

// An Ajaib TRADE frame shaped like the recorded ones, at a WIB time today.
const ajaibTrade = (trade: {
  readonly seq: number
  readonly wib: string
  readonly ticker: string
  readonly price: number
  readonly lot: number
  readonly board?: "TN" | "NG"
}) =>
  JSON.stringify({
    ...JSON.parse(recordedTrades.session1[0]!),
    ticker: trade.ticker,
    price: trade.price,
    lot: trade.lot,
    value: trade.price * trade.lot * 100,
    tradedAt: `2026-11-09T${trade.wib}.000+07:00`,
    tradeNum: `20261109${String(trade.seq).padStart(10, "0")}`,
    ...(trade.board === undefined ? {} : { market_type: trade.board }),
  })

// A recorded Ajaib PRICE frame, its figures and time changed.
const ajaibPrice = (
  price: Record<string, unknown> & { readonly wib: string }
) =>
  JSON.stringify({
    ...JSON.parse(recordedPrice.frames[0]!),
    ...price,
    wib: undefined,
    updateTime: Date.parse(`2026-11-09T${price.wib}+07:00`),
  })

const tradingDay = Effect.fnUntraced(function* () {
  // 09:51:05 WIB, session 1: just after the recorded frames.
  yield* TestClock.setTime(Date.parse("2026-11-09T02:51:05.000Z"))
  const viewers: Array<FakeSocket> = []
  const relays: Array<FakeSocket> = []
  const scope = yield* Scope.make()
  const day = yield* makeTradingDay({
    sql: memorySql(),
    date: DAY,
    viewers: Effect.sync(() => viewers),
    viewersOf: () => Effect.succeed([]),
    ingests: Effect.sync(() => relays),
  }).pipe(Scope.provide(scope))
  const ingest = (socket: FakeSocket, text: string) =>
    day.ingestMessage(socket, text).pipe(Effect.provide(env))
  const relay = Effect.fnUntraced(function* () {
    const socket = new FakeSocket()
    relays.push(socket)
    yield* ingest(
      socket,
      yield* encodeIngestUp({
        _tag: "Token",
        protocolVersion: IngestProtocolVersion,
        token: TOKEN,
      })
    )
    const send = Effect.fnUntraced(function* (
      message: Parameters<typeof encodeIngestUp>[0]
    ) {
      yield* ingest(socket, yield* encodeIngestUp(message))
    })
    // Everything the relay was sent down its ingest socket.
    const received = Effect.suspend(() =>
      Effect.forEach(socket.sent, (text) => decodeIngestDown(text))
    )
    return {
      received,
      stockbit: (rows: ReadonlyArray<LivePriceRow>, connection: "A" | "B") =>
        send({
          _tag: "Frames",
          protocolVersion: IngestProtocolVersion,
          feed: "Stockbit",
          connection,
          receivedAt: DateTime.makeUnsafe("2026-11-09T02:51:02.000Z"),
          frames: rows.map(livePriceFrame),
        }),
      stockbitIndex: (rows: ReadonlyArray<IndexRow>, connection: "A" | "B") =>
        send({
          _tag: "Frames",
          protocolVersion: IngestProtocolVersion,
          feed: "Stockbit",
          connection,
          receivedAt: DateTime.makeUnsafe("2026-11-09T07:19:28.000Z"),
          frames: rows.map(indexFrame),
        }),
      stockbitTrades: (rows: ReadonlyArray<StockbitRow>) =>
        send({
          _tag: "Frames",
          protocolVersion: IngestProtocolVersion,
          feed: "Stockbit",
          connection: "A",
          receivedAt: DateTime.makeUnsafe("2026-11-09T02:51:02.000Z"),
          frames: [runningTradeBatch(rows)],
        }),
      ajaib: (frames: ReadonlyArray<string>) =>
        send({
          _tag: "Frames",
          protocolVersion: IngestProtocolVersion,
          feed: "Ajaib",
          stream: "trade",
          connection: "A",
          receivedAt: DateTime.makeUnsafe("2026-11-09T02:51:02.000Z"),
          frames,
        }),
    }
  })
  const select = Effect.fnUntraced(function* (
    socket: FakeSocket,
    selected: string,
    watchlist: ReadonlyArray<string>
  ) {
    yield* day.viewerMessage(
      socket,
      yield* encodeViewerUp({
        _tag: "Select",
        protocolVersion: ViewerProtocolVersion,
        selected: StockCode.make(selected),
        watchlist: watchlist.map((code) => StockCode.make(code)),
      })
    )
  })
  const viewer = Effect.fnUntraced(function* (
    selected: string,
    watchlist: ReadonlyArray<string>
  ) {
    const socket = new FakeSocket()
    viewers.push(socket)
    yield* select(socket, selected, watchlist)
    return socket
  })
  const leave = Effect.fnUntraced(function* (socket: FakeSocket) {
    viewers.splice(viewers.indexOf(socket), 1)
    yield* day.viewerClosed(socket)
  })
  return { relay, viewer, select, leave }
})

const received = (socket: FakeSocket) =>
  Effect.forEach(socket.sent, (text) => decodeViewerDown(text))

// A message's Day states by code, their codes and times as plain text.
const statesOf = (message: ViewerDown) =>
  Object.fromEntries(
    (message.dayStates ?? []).map((state: DayState) => [
      state.code,
      {
        ...state,
        code: String(state.code),
        asOf: DateTime.formatIso(state.asOf),
      },
    ])
  )

// What BBRI's recorded frame says, as a Day state.
const BBRI_FROM_STOCKBIT = {
  code: "BBRI",
  last: 2920,
  previousClose: 2930,
  change: { amount: -10, percent: -0.3412969283276451 },
  open: 2930,
  high: 2950,
  low: 2910,
  volume: 224_118,
  value: 65_698_513_000,
  frequency: 6908,
  asOf: "2026-11-09T02:51:01.396Z",
  provenance: "Stockbit" as const,
}

// BBRI's recorded frame a second later, with a new last price.
const BBRI_NEWER: LivePriceRow = {
  ...BBRI,
  last: 2950,
  change: 20,
  changePercent: 0.6825938566552902,
  date: "2026-11-09T09:51:02.396114+07:00",
}

describe("Day state under overlapping ingest callbacks", () => {
  it.effect(
    "a newer liveprice frame is not overwritten by an older one whose callback yielded mid-way",
    () =>
      Effect.gen(function* () {
        const operations = yield* everySplit({
          setup: Effect.gen(function* () {
            const { relay, viewer } = yield* tradingDay()
            return { feed: yield* relay(), viewer }
          }),
          first: ({ feed }) => feed.stockbit([BBRI], "A"),
          second: ({ feed }) => feed.stockbit([BBRI_NEWER], "B"),
          check: ({ viewer }, at) =>
            Effect.gen(function* () {
              const [snapshot] = yield* received(yield* viewer("BBRI", []))
              assert(snapshot !== undefined)
              assert.deepStrictEqual(
                statesOf(snapshot).BBRI,
                {
                  ...BBRI_FROM_STOCKBIT,
                  last: 2950,
                  change: { amount: 20, percent: 0.6825938566552902 },
                  asOf: "2026-11-09T02:51:02.396Z",
                },
                `the older frame's callback yielded at operation ${at}`
              )
            }),
        })
        assert.isAbove(operations, 0)
      }),
    60_000
  )
})

describe("Day state", () => {
  it.effect(
    "a snapshot has each selected and watchlist code's last liveprice frame, and none for a code without one",
    () =>
      Effect.gen(function* () {
        const { relay, viewer } = yield* tradingDay()
        const feed = yield* relay()
        yield* feed.stockbit(LIVE_PRICES, "A")
        // Connection B's copy of an older TINS frame changes nothing.
        yield* feed.stockbit(
          [
            {
              ...TINS,
              last: 3480,
              date: "2026-11-09T09:51:00.000000+07:00",
            },
          ],
          "B"
        )
        const page = yield* viewer("TINS", ["BBRI", "ASII"])
        const [snapshot] = yield* received(page)
        const states = statesOf(snapshot!)
        assert.deepStrictEqual(Object.keys(states).sort(), ["BBRI", "TINS"])
        assert.deepStrictEqual(states.BBRI, BBRI_FROM_STOCKBIT)
        assert.strictEqual(states.TINS!.last, 3490)
        assert.strictEqual(states.TINS!.volume, 159_047)
      })
  )

  it.effect(
    "an index's frames carry no previous close, so its Day state has none and no change, rather than one run from a price seen today",
    () =>
      Effect.gen(function* () {
        const { relay, viewer } = yield* tradingDay()
        const feed = yield* relay()
        yield* feed.stockbitIndex(recordedIhsg.ihsg, "A")
        const page = yield* viewer("IHSG", [])
        const [snapshot] = yield* received(page)
        assert.deepStrictEqual(statesOf(snapshot!).IHSG, {
          code: "IHSG",
          last: 4971.287,
          open: 4955.834,
          high: 4983.81,
          low: 4925.101,
          volume: 241_870_237,
          value: 4_224_616_955_900,
          frequency: 674_825,
          asOf: "2026-11-09T07:19:27.145Z",
          provenance: "Stockbit",
        })
      })
  )

  it.effect("a delta carries the watched codes' changed Day states only", () =>
    Effect.gen(function* () {
      const { relay, viewer } = yield* tradingDay()
      const feed = yield* relay()
      yield* feed.stockbit(LIVE_PRICES, "A")
      const page = yield* viewer("BBCA", ["BBRI"])
      yield* feed.stockbit(
        [
          {
            ...BBRI,
            last: 2930,
            volume: 22_412_300,
            frequency: 6909,
            value: 65_699_978_000,
            change: 0,
            changePercent: 0,
            date: "2026-11-09T09:51:03.000000+07:00",
          },
          // Nobody watches CTTH.
          {
            ...LIVE_PRICES[0]!,
            last: 118,
            date: "2026-11-09T09:51:03.000000+07:00",
          },
        ],
        "A"
      )
      yield* TestClock.adjust("250 millis")
      const [, delta] = yield* received(page)
      assert.deepStrictEqual(Object.keys(statesOf(delta!)), ["BBRI"])
      assert.deepInclude(statesOf(delta!).BBRI, {
        last: 2930,
        change: { amount: 0, percent: 0 },
        volume: 224_123,
        frequency: 6909,
        provenance: "Stockbit",
      })
    })
  )

  it.effect(
    "with Stockbit lost, the merged tape's regular-board trades and Ajaib's PRICE carry on from the last liveprice",
    () =>
      Effect.gen(function* () {
        const { relay, viewer } = yield* tradingDay()
        const feed = yield* relay()
        yield* feed.stockbit([BBRI], "A")
        yield* feed.ajaib([
          // Before the frame: already in its totals.
          ajaibTrade({
            seq: 700_001,
            wib: "09:51:00",
            ticker: "BBRI",
            price: 2960,
            lot: 5,
          }),
          ajaibTrade({
            seq: 700_002,
            wib: "09:51:10",
            ticker: "BBRI",
            price: 2940,
            lot: 10,
          }),
          ajaibTrade({
            seq: 700_003,
            wib: "09:51:12",
            ticker: "BBRI",
            price: 2900,
            lot: 4,
          }),
          // The cash board is not in the day's figures.
          ajaibTrade({
            seq: 700_004,
            wib: "09:51:13",
            ticker: "BBRI",
            price: 3000,
            lot: 50,
            board: "TN",
          }),
        ])
        // Stockbit still live: its frame stands.
        const early = yield* viewer("BBRI", [])
        const [live] = yield* received(early)
        assert.deepStrictEqual(statesOf(live!).BBRI, BBRI_FROM_STOCKBIT)

        // 15 s without a Stockbit frame: lost.
        yield* TestClock.adjust("15 seconds")
        const fallback = {
          ...BBRI_FROM_STOCKBIT,
          last: 2900,
          change: { amount: -30, percent: (-30 / 2930) * 100 },
          high: 2950,
          low: 2900,
          volume: 224_118 + 14,
          value: 65_698_513_000 + 2940 * 1000 + 2900 * 400,
          frequency: 6908 + 2,
          asOf: "2026-11-09T02:51:12.000Z",
          provenance: "Ajaib" as const,
        }
        const page = yield* viewer("BBCA", ["BBRI"])
        const [snapshot] = yield* received(page)
        assert.deepStrictEqual(statesOf(snapshot!).BBRI, fallback)

        // Ajaib's PRICE fills the last price and the change.
        yield* feed.ajaib([
          ajaibPrice({
            ticker: "BBRI",
            price: 2910,
            change: -20,
            pctChange: -0.006826,
            close: 2930,
            wib: "09:51:14",
          }),
        ])
        yield* TestClock.adjust("250 millis")
        const delta = (yield* received(page)).at(-1)!
        assert.deepStrictEqual(statesOf(delta).BBRI, {
          ...fallback,
          last: 2910,
          change: { amount: -20, percent: -0.006826 * 100 },
          asOf: "2026-11-09T02:51:14.000Z",
        })

        // Stockbit back: its next frame is the figure again.
        yield* feed.stockbit(
          [{ ...BBRI, last: 2910, date: "2026-11-09T09:51:20.000000+07:00" }],
          "A"
        )
        yield* TestClock.adjust("250 millis")
        assert.deepInclude(statesOf((yield* received(page)).at(-1)!).BBRI, {
          last: 2910,
          provenance: "Stockbit",
        })
      })
  )

  it.effect(
    "with Stockbit lost, Stockbit's late copy of a trade Ajaib brought corrects the figures carried on from it",
    () =>
      Effect.gen(function* () {
        const { relay, viewer } = yield* tradingDay()
        const feed = yield* relay()
        yield* feed.stockbit([BBRI], "A")
        yield* feed.ajaib([
          ajaibTrade({
            seq: 700_002,
            wib: "09:51:10",
            ticker: "BBRI",
            price: 2940,
            lot: 10,
          }),
          // No market_type: Ajaib shows it on the regular board.
          ajaibTrade({
            seq: 700_003,
            wib: "09:51:12",
            ticker: "BBRI",
            price: 3000,
            lot: 50,
          }),
        ])
        // Stockbit, a moment behind: 700002 at 2950, 700003 on the cash board.
        yield* feed.stockbitTrades([
          {
            tradeWib: "09:51:10.400",
            code: "BBRI",
            price: 2950,
            volume: 1000,
            action: 1,
            board: 1,
            tradeNumber: 700_002,
          },
          {
            tradeWib: "09:51:12.400",
            code: "BBRI",
            price: 3000,
            volume: 5000,
            action: 1,
            board: 2,
            tradeNumber: 700_003,
          },
        ])
        // 15 s without a Stockbit frame: lost.
        yield* TestClock.adjust("15 seconds")
        const page = yield* viewer("BBCA", ["BBRI"])
        const [snapshot] = yield* received(page)
        assert.deepStrictEqual(statesOf(snapshot!).BBRI, {
          ...BBRI_FROM_STOCKBIT,
          last: 2950,
          change: { amount: 20, percent: (20 / 2930) * 100 },
          high: 2950,
          volume: 224_118 + 10,
          value: 65_698_513_000 + 2950 * 1000,
          frequency: 6908 + 1,
          asOf: "2026-11-09T02:51:10.400Z",
          provenance: "Ajaib",
        })
      })
  )

  it.effect(
    "a liveprice frame arriving after a trade newer than it keeps that trade in the figures carried on",
    () =>
      Effect.gen(function* () {
        const { relay, viewer } = yield* tradingDay()
        const feed = yield* relay()
        yield* feed.stockbit([BBRI], "A")
        yield* feed.ajaib([
          ajaibTrade({
            seq: 700_002,
            wib: "09:51:03",
            ticker: "BBRI",
            price: 2940,
            lot: 10,
          }),
        ])
        // Connection B's frame: newer than the base, older than the trade.
        yield* feed.stockbit(
          [{ ...BBRI, date: "2026-11-09T09:51:02.000000+07:00" }],
          "B"
        )
        // 15 s without a Stockbit frame: lost.
        yield* TestClock.adjust("15 seconds")
        const page = yield* viewer("BBCA", ["BBRI"])
        const [snapshot] = yield* received(page)
        assert.deepStrictEqual(statesOf(snapshot!).BBRI, {
          ...BBRI_FROM_STOCKBIT,
          last: 2940,
          change: { amount: 10, percent: (10 / 2930) * 100 },
          volume: 224_118 + 10,
          value: 65_698_513_000 + 2940 * 1000,
          frequency: 6908 + 1,
          asOf: "2026-11-09T02:51:03.000Z",
          provenance: "Ajaib",
        })
      })
  )

  it.effect(
    "with Stockbit lost, the last price stays exact when later copies move every newer trade off the regular board",
    () =>
      Effect.gen(function* () {
        const { relay, viewer } = yield* tradingDay()
        const feed = yield* relay()
        yield* feed.stockbit([BBRI], "A")
        // Seventeen trades Ajaib shows on the regular board, 2921 rising.
        const trades = Array.from({ length: 17 }, (_, index) => ({
          seq: 700_001 + index,
          wib: `09:51:${10 + index}`,
          price: 2921 + index,
        }))
        yield* feed.ajaib(
          trades.map((trade) =>
            ajaibTrade({ ...trade, ticker: "BBRI", lot: 5 })
          )
        )
        // Stockbit has every one but the first on the cash board.
        yield* feed.stockbitTrades(
          trades.slice(1).map((trade) => ({
            tradeWib: `${trade.wib}.400`,
            code: "BBRI",
            price: trade.price,
            volume: 500,
            action: 1,
            board: 2,
            tradeNumber: trade.seq,
          }))
        )
        yield* TestClock.adjust("15 seconds")
        const page = yield* viewer("BBCA", ["BBRI"])
        const [snapshot] = yield* received(page)
        assert.deepStrictEqual(statesOf(snapshot!).BBRI, {
          ...BBRI_FROM_STOCKBIT,
          last: 2921,
          change: { amount: -9, percent: (-9 / 2930) * 100 },
          volume: 224_118 + 5,
          value: 65_698_513_000 + 2921 * 500,
          frequency: 6908 + 1,
          asOf: "2026-11-09T02:51:10.000Z",
          provenance: "Ajaib",
        })
      })
  )

  it.effect(
    "a code Stockbit never sent starts from Ajaib's PRICE while Stockbit is lost",
    () =>
      Effect.gen(function* () {
        const { relay, viewer } = yield* tradingDay()
        const feed = yield* relay()
        yield* feed.ajaib(
          recordedPrice.frames.map((frame, i) =>
            ajaibPrice({ ...JSON.parse(frame), wib: `09:51:0${i}` })
          )
        )
        const page = yield* viewer("BBCA", [])
        const [snapshot] = yield* received(page)
        assert.deepStrictEqual(statesOf(snapshot!).BBCA, {
          code: "BBCA",
          last: 5050,
          previousClose: 5125,
          change: { amount: -75, percent: -0.014634 * 100 },
          open: 5025,
          high: 5100,
          low: 4990,
          // The newest frame's 64,439,800 shares.
          volume: 644_398,
          value: 0,
          frequency: 0,
          asOf: "2026-11-09T02:51:01.000Z",
          provenance: "Ajaib",
        })
      })
  )
})

describe("the Ajaib on-demand codes", () => {
  it.effect(
    "the union of viewers' selected and watchlist codes goes down the ingest socket when it changes",
    () =>
      Effect.gen(function* () {
        const { relay, viewer, select, leave } = yield* tradingDay()
        const feed = yield* relay()
        const codes = Effect.map(
          feed.received,
          (messages): Array<Array<string>> =>
            messages.map((message) =>
              message._tag === "OnDemandCodes" ? [...message.codes] : []
            )
        )
        // None yet: the relay is told nothing.
        assert.deepStrictEqual(yield* codes, [])

        const ayu = yield* viewer("BBCA", ["BBRI", "TLKM"])
        const budi = yield* viewer("GOTO", ["BBRI"])
        // The same set again sends nothing.
        yield* select(budi, "GOTO", ["BBRI"])
        // Budi still watches BBRI.
        yield* select(ayu, "BBCA", ["BBRI"])
        yield* leave(budi)
        assert.deepStrictEqual(yield* codes, [
          ["BBCA", "BBRI", "TLKM"],
          ["BBCA", "BBRI", "GOTO", "TLKM"],
          ["BBCA", "BBRI", "GOTO"],
          ["BBCA", "BBRI"],
        ])

        // A relay that connects later is told the set at once.
        const late = yield* relay()
        assert.deepStrictEqual(
          (yield* late.received).map((message): Array<string> =>
            message._tag === "OnDemandCodes" ? [...message.codes] : []
          ),
          [["BBCA", "BBRI"]]
        )
      })
  )
})
