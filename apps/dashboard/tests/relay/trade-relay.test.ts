import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { Sweep, Trade, TradeFrame } from "@/domain/trade"
import type { IngestControl } from "@/relay/ingest-control"
import { INGEST_PATH, MARKET, TRADES_PATH, TRADES_QUERY } from "@/relay/routes"
import { relayStore } from "@/relay/store"
import type { StoredQuote } from "@/relay/store"
import { AUTH_MS, TradeRelay } from "@/relay/trade-relay"
import { sketchOf } from "@/relay/whale"
import { WHALE_REPLAY_KEY } from "@/relay/whale-persistence"

import { sqlStorage } from "../support/sql-storage"
import { wireBatch, wireLivePrice } from "../support/stockbit-wire"
import { bbcaWall, enrgSweep } from "../support/whales"

const BBCA = Symbol.make("BBCA")
const TLKM = Symbol.make("TLKM")
const YESTERDAY = "2026-10-28"
const TODAY = "2026-10-29"
const TOMORROW = "2026-10-30"
const NOW = "2026-10-29T03:00:00.000Z"
const SECRET = "ingest-secret"
const ENV = { RELAY_INGEST_SECRET: SECRET } as Env

class FakeSocket {
  readonly sent: Array<string> = []
  readyState: number = WebSocket.OPEN
  private attachment: unknown = null
  /** The code the relay closed it with, if it did. */
  closedWith: number | null = null
  send(message: string) {
    this.sent.push(message)
  }
  serializeAttachment(value: unknown) {
    this.attachment = value
  }
  deserializeAttachment() {
    return this.attachment
  }
  /** Stays OPEN, as a real socket does until its close handshake ends. */
  close(code: number) {
    this.closedWith = code
  }
  get frames(): Array<TradeFrame> {
    return this.sent.map((m) => JSON.parse(m) as TradeFrame)
  }
}

/** The object's state, which outlives an instance as it outlives a wake. */
const objectState = () => {
  const kv = new Map<string, unknown>()
  const accepted: Array<{ socket: FakeSocket; tags: Array<string> }> = []
  const sql = sqlStorage()
  const ctx = {
    storage: {
      sql,
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => void kv.set(key, value),
        delete: (key: string) => kv.delete(key),
      },
      getAlarm: () => Promise.resolve(null),
      setAlarm: () => Promise.resolve(),
    },
    setWebSocketAutoResponse: () => undefined,
    acceptWebSocket: (socket: FakeSocket, tags: Array<string>) =>
      accepted.push({ socket, tags }),
    getWebSockets: (tag: string) =>
      accepted.filter((a) => a.tags.includes(tag)).map((a) => a.socket),
    getTags: (socket: FakeSocket) =>
      accepted.find((a) => a.socket === socket)?.tags ?? [],
    getWebSocketAutoResponseTimestamp: () => null,
  } as unknown as DurableObjectState
  const open = async (relay: TradeRelay, path: string) => {
    await relay.fetch(new Request(`http://relay${path}`))
    const last = accepted.at(-1)
    if (!last) throw new Error("no socket accepted")
    return last.socket
  }
  /** An ingest past its handshake: the auth message is its first. */
  const openIngest = async (relay: TradeRelay) => {
    const socket = await open(relay, INGEST_PATH)
    relay.webSocketMessage(
      socket as unknown as WebSocket,
      JSON.stringify({ type: "auth", secret: SECRET })
    )
    return socket
  }
  return { ctx, sql, open, openIngest }
}

const started = async () => {
  const state = objectState()
  const relay = new TradeRelay(state.ctx, ENV)
  const ingest = await state.openIngest(relay)
  relay.webSocketMessage(
    ingest as unknown as WebSocket,
    JSON.stringify({ type: "datafeed", open: true })
  )
  const send = (bytes: Uint8Array) =>
    relay.webSocketMessage(
      ingest as unknown as WebSocket,
      bytes.buffer as ArrayBuffer
    )
  return {
    ...state,
    relay,
    ingest,
    send,
    /** A page's new socket: what it hears is on its `frames`. */
    page: (symbol: Symbol = BBCA) =>
      state.open(relay, `${TRADES_PATH}?${TRADES_QUERY.symbol}=${symbol}`),
    livePrice: (day: string, volume: number) =>
      send(wireLivePrice({ stock: BBCA, date: `${day}T09:30:00.000`, volume })),
    trade: (day: string, tradeNumber: number) =>
      send(
        wireBatch([
          {
            stock: BBCA,
            time: `${day}T03:00:00.000Z`,
            tradeNumber,
            price: 9000,
            change: 50,
          },
        ])
      ),
  }
}

/** A stored row, `at` seconds after the day's start. */
const storedSweep = ({
  firstNumber,
  at,
  day = TODAY,
  symbol = BBCA,
  side = "buy",
  value = 100,
}: {
  firstNumber: number
  at: number
  day?: string
  symbol?: Symbol
  side?: Sweep["side"]
  value?: number
}): Sweep => {
  const instant = IsoDateTime.make(
    new Date(Date.parse(`${day}T02:00:00.000Z`) + at * 1000).toISOString()
  )
  return {
    ...enrgSweep,
    day,
    symbol,
    side,
    value,
    firstNumber,
    lastNumber: firstNumber,
    tradedAt: instant,
    announcedAt: instant,
    updatedAt: instant,
  }
}

const quoteRows = (sql: SqlStorage) =>
  sql.exec<{ day: string }>("SELECT day FROM live_quote").toArray()

const quoteFrames = (frames: ReadonlyArray<TradeFrame>) =>
  frames.filter((f) => f.type === "quote")

const yesterdaysRow: StoredQuote = {
  totals: {
    day: YESTERDAY,
    prev: 8900,
    open: 8950,
    high: null,
    low: null,
    avg: null,
    volume: 100_000,
    value: null,
    freq: null,
    sourceAt: null,
    asOf: IsoDateTime.make("2026-10-28T08:00:00.000Z"),
  },
  writtenAt: Date.parse(NOW),
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(NOW) })
  class Pair {
    0 = new FakeSocket()
    1 = new FakeSocket()
  }
  vi.stubGlobal("WebSocketPair", Pair)
  vi.stubGlobal("WebSocketRequestResponsePair", class {})
  // Node's own refuses status 101.
  vi.stubGlobal("Response", class {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("the quote the relay serves is of the day it reports", () => {
  test("before any trade, a frame is neither held, written, sent nor served", async () => {
    const { relay, page, livePrice, sql } = await started()
    const open = await page()
    livePrice(TODAY, 100_000)

    const backfill = relay.backfill(BBCA)
    expect(backfill.day).toBeNull()
    expect(backfill.quote.volumeLot).toBeNull()
    expect(backfill.quoteAsOf).toBeNull()
    expect(quoteRows(sql)).toEqual([])
    expect(quoteFrames(open.frames)).toEqual([])
    expect(quoteFrames((await page()).frames)).toEqual([])
  })

  test("the first trade leaves none of an earlier day's totals, and tells the open page", async () => {
    const { relay, page, livePrice, trade, sql } = await started()
    const open = await page()
    livePrice(YESTERDAY, 100_000)
    trade(TODAY, 1)

    const backfill = relay.backfill(BBCA)
    expect(backfill.day).toBe(TODAY)
    expect(backfill.quote.volumeLot).toBeNull()
    expect(backfill.quote.last).toBe(9000)
    expect(backfill.quoteAsOf).toBe(NOW)
    expect(quoteRows(sql)).toEqual([])
    expect(open.frames.filter((f) => f.type === "status").at(-1)).toMatchObject(
      {
        type: "status",
        status: { day: TODAY },
      }
    )
  })

  test("a first trade that is a resend of an earlier day serves no newer day's totals", async () => {
    const { relay, livePrice, trade } = await started()
    livePrice(TODAY, 100_000)
    trade(YESTERDAY, 1)

    const backfill = relay.backfill(BBCA)
    expect(backfill.day).toBe(YESTERDAY)
    expect(backfill.quote.volumeLot).toBeNull()
  })

  test("a frame of the relay's day folds and is served, and the next day's first trade clears it", async () => {
    const { relay, page, livePrice, trade, sql } = await started()
    const open = await page()
    trade(TODAY, 1)
    livePrice(TODAY, 100_000)

    expect(relay.backfill(BBCA).quote.volumeLot).toBe(1000)
    expect(quoteFrames(open.frames)).toHaveLength(1)
    expect(quoteFrames((await page()).frames)).toHaveLength(1)

    trade(TOMORROW, 1)
    expect(relay.backfill(BBCA)).toMatchObject({
      day: TOMORROW,
      quote: { volumeLot: null, last: 9000 },
    })
    expect(quoteRows(sql)).toEqual([])
  })

  test("rows that predate the relay's first day go at its first trade", async () => {
    const state = objectState()
    const store = relayStore(state.sql)
    store.create()
    store.writeQuote(BBCA, yesterdaysRow)
    store.addCoverage(YESTERDAY, "2026-10-28T08:00:00.000Z", "extension")

    const relay = new TradeRelay(state.ctx, ENV)
    expect(relay.backfill(BBCA).quote.volumeLot).toBeNull()

    const ingest = await state.openIngest(relay)
    const socket = ingest as unknown as WebSocket
    relay.webSocketMessage(
      socket,
      JSON.stringify({ type: "datafeed", open: true })
    )
    relay.webSocketMessage(
      socket,
      wireBatch([
        { stock: BBCA, time: `${TODAY}T03:00:00.000Z`, tradeNumber: 1 },
      ]).buffer as ArrayBuffer
    )

    expect(quoteRows(state.sql)).toEqual([])
    expect(store.coverage().map((c) => c.at)).not.toContain(
      "2026-10-28T08:00:00.000Z"
    )
  })

  test("a day's clear carries the source it began with, so a connected day reads covered", () => {
    const store = relayStore(objectState().sql)
    store.create()
    store.addCoverage(YESTERDAY, "2026-10-28T02:00:00.000Z", "none")
    store.addCoverage(YESTERDAY, "2026-10-28T08:00:00.000Z", "extension")
    store.addCoverage(TODAY, "2026-10-29T01:00:00.000Z", "upstream")
    store.clearDay(TODAY)
    expect(store.coverage()).toEqual([
      { at: "2026-10-28T17:00:00.000Z", source: "extension" },
      { at: "2026-10-29T01:00:00.000Z", source: "upstream" },
    ])
  })

  test("a live symbol's candles fold the whole tape, past the backfill's window, at its seq", async () => {
    const { trade, relay } = await started()
    await trade("2026-10-29", 1)
    await trade("2026-10-29", 2)
    const { backfill, candles } = relay.liveSymbol(BBCA)
    expect(candles.lastNumber).toBe(2)
    expect(candles.candles).toHaveLength(1)
    expect(backfill.seq).toBeGreaterThan(0)
    expect(backfill.symbol).toBe(BBCA)
  })

  test("a backfill carries the session's off-board trades past the newest 200, newest first", async () => {
    const { send, relay } = await started()
    const at = (n: number) => ({
      stock: BBCA,
      time: `${TODAY}T03:00:00.000Z`,
      tradeNumber: n,
    })
    send(
      wireBatch([
        { ...at(1), board: 3 },
        { ...at(2), board: 2 },
      ])
    )
    send(wireBatch(Array.from({ length: 250 }, (_, i) => at(i + 3))))
    send(wireBatch([{ ...at(253), board: 3 }]))

    const { trades, offBoard } = relay.backfill(BBCA)
    expect(trades).toHaveLength(200)
    expect(offBoard.map((t) => [t.tradeNumber, t.board])).toEqual([
      [253, "NG"],
      [2, "TN"],
      [1, "NG"],
    ])
  })

  test("a backfill keeps the newest 500 off-board trades", async () => {
    const { send, relay } = await started()
    send(
      wireBatch(
        Array.from({ length: 501 }, (_, i) => ({
          stock: BBCA,
          time: `${TODAY}T03:00:00.000Z`,
          tradeNumber: i + 1,
          board: 3,
        }))
      )
    )

    const { offBoard } = relay.backfill(BBCA)
    expect(offBoard).toHaveLength(500)
    expect(offBoard[0]?.tradeNumber).toBe(501)
    expect(offBoard.at(-1)?.tradeNumber).toBe(2)
  })

  test("after a wake, a row of another day than the tape's stays unserved", async () => {
    const state = objectState()
    const store = relayStore(state.sql)
    store.create()
    const at = IsoDateTime.make(NOW)
    const rg: Trade = {
      symbol: BBCA,
      price: 9000,
      volume: 100,
      value: 900_000,
      side: "buy",
      board: "RG",
      tradeNumber: 1,
      tradedAt: at,
      receivedAt: at,
      change: 50,
    }
    store.appendBatch(BBCA, 1, TODAY, at, [rg], rg)
    store.writeQuote(BBCA, yesterdaysRow)

    const woken = new TradeRelay(state.ctx, ENV)
    expect(woken.backfill(BBCA)).toMatchObject({
      day: TODAY,
      quote: { volumeLot: null, open: null, prev: 8950, last: 9000 },
      quoteAsOf: NOW,
    })
    const open = await state.open(
      woken,
      `${TRADES_PATH}?${TRADES_QUERY.symbol}=${BBCA}`
    )
    expect(quoteFrames(open.frames)).toEqual([
      expect.objectContaining({
        quote: expect.objectContaining({ volumeLot: null, last: 9000 }),
      }),
    ])
  })
})

describe("a served quote's as-of is its own symbol's", () => {
  const later = (ms: number) => {
    vi.advanceTimersByTime(ms)
    return new Date().toISOString()
  }

  test("another symbol's later trade leaves a traded symbol's as-of alone", async () => {
    const { relay, page, trade, send } = await started()
    trade(TODAY, 1)
    const newest = later(60_000)
    send(
      wireBatch([
        { stock: TLKM, time: `${TODAY}T03:01:00.000Z`, tradeNumber: 1 },
      ])
    )
    expect(relay.status().lastTradeAt).toBe(newest)

    const backfill = relay.backfill(BBCA)
    expect(backfill.quoteAsOf).toBe(NOW)
    expect(backfill.provenance.asOf).toBe(NOW)
    expect(quoteFrames((await page()).frames)).toEqual([
      expect.objectContaining({
        provenance: expect.objectContaining({ asOf: NOW }),
      }),
    ])
  })

  test("another symbol's later trade leaves an untraded symbol's as-of alone", async () => {
    const { relay, page, trade, send } = await started()
    trade(TODAY, 1)
    const quotedAt = later(60_000)
    send(
      wireLivePrice({
        stock: TLKM,
        date: `${TODAY}T09:30:00.000`,
        volume: 100_000,
      })
    )
    const newest = later(60_000)
    trade(TODAY, 2)
    expect(relay.status().lastTradeAt).toBe(newest)

    const backfill = relay.backfill(TLKM)
    expect(backfill.trades).toEqual([])
    expect(backfill.quoteAsOf).toBe(quotedAt)
    expect(backfill.provenance.asOf).toBe(quotedAt)
    expect(quoteFrames((await page(TLKM)).frames)).toEqual([
      expect.objectContaining({
        provenance: expect.objectContaining({ asOf: quotedAt }),
      }),
    ])
  })
})

describe("the status carries the relay's source record", () => {
  const lastStatus = (socket: FakeSocket) =>
    socket.frames.filter((f) => f.type === "status").at(-1)?.status

  test("an opening page's first status holds the record", async () => {
    const { relay, page } = await started()
    const socket = await page()
    expect(socket.frames[0]).toMatchObject({
      type: "status",
      status: { coverage: relay.backfill(BBCA).coverage },
    })
    expect(relay.backfill(BBCA).coverage.at(-1)?.source).toBe("extension")
  })

  test("a source change pushes a status ending with its row", async () => {
    const { relay, page, ingest } = await started()
    const socket = await page()
    vi.advanceTimersByTime(60_000)
    ingest.readyState = WebSocket.CLOSED
    relay.webSocketClose(ingest as unknown as WebSocket, 1006)
    expect(lastStatus(socket)?.coverage.at(-1)).toEqual({
      at: "2026-10-29T03:01:00.000Z",
      source: "none",
    })
  })

  test("a handover between two extensions pushes the record, though the source reads the same", async () => {
    const { relay, page, openIngest, ingest } = await started()
    // The alarm closes a silent ingest; the runtime's close event comes later.
    ingest.close = () => {
      ingest.readyState = WebSocket.CLOSED
    }
    vi.advanceTimersByTime(10_000)
    const second = await openIngest(relay)
    relay.webSocketMessage(
      second as unknown as WebSocket,
      JSON.stringify({ type: "datafeed", open: true })
    )
    const socket = await page()
    const before = lastStatus(socket)?.coverage.length ?? 0
    vi.advanceTimersByTime(40_000)
    await relay.alarm()
    const after = lastStatus(socket)
    expect(after?.source).toBe("extension")
    expect(after?.coverage).toHaveLength(before + 1)
    expect(after?.coverage.at(-1)?.source).toBe("extension")
  })

  test("a day clear pushes the rewritten record", async () => {
    const { page, trade } = await started()
    await trade(TODAY, 1)
    const socket = await page()
    vi.setSystemTime(new Date(`${TOMORROW}T03:00:00.000Z`))
    await trade(TOMORROW, 1)
    expect(lastStatus(socket)?.coverage).toEqual([
      { at: "2026-10-29T17:00:00.000Z", source: "extension" },
    ])
  })
})

describe("the relay's calendar", () => {
  test("is the operator's list, which lists the current year", () => {
    const relay = new TradeRelay(objectState().ctx, ENV)
    expect(relay.status().calendarOutOfDate).toBe(false)
  })

  test("is RELAY_CALENDAR's when the environment gives one", () => {
    const unlisted = JSON.stringify({ holidays: {}, exceptions: {} })
    const relay = new TradeRelay(objectState().ctx, {
      ...ENV,
      RELAY_CALENDAR: unlisted,
    })
    expect(relay.status().calendarOutOfDate).toBe(true)
  })
})

describe("the own session's switch", () => {
  test("switching off tells every connected ingest to stop sending credentials", async () => {
    const stockbit = vi.fn<typeof fetch>(() =>
      Promise.reject(new Error("no network"))
    )
    vi.stubGlobal("fetch", stockbit)
    const { relay, ingest, openIngest } = await started()
    const second = await openIngest(relay)
    const credentialMessages = (socket: FakeSocket) =>
      socket.sent
        .map((m) => (JSON.parse(m) as { type: string }).type)
        .filter((type) => type.startsWith("credential-"))

    await relay.setOwnSession(true)
    await relay.setOwnSession(false)

    expect(credentialMessages(ingest)).toEqual([
      "credential-needed",
      "credential-stop",
    ])
    expect(credentialMessages(second)).toEqual([
      "credential-needed",
      "credential-stop",
    ])
    expect(stockbit).not.toHaveBeenCalled()
  })
})

describe("the ingest's handshake", () => {
  const BATCH = wireBatch([
    { stock: BBCA, time: `${TODAY}T03:00:00.000Z`, tradeNumber: 1 },
  ])
  /** A new ingest that has not yet said anything. */
  const fresh = async () => {
    const state = objectState()
    const relay = new TradeRelay(state.ctx, ENV)
    const socket = await state.open(relay, INGEST_PATH)
    const say = (message: string | Uint8Array) =>
      relay.webSocketMessage(
        socket as unknown as WebSocket,
        typeof message === "string" ? message : (message.buffer as ArrayBuffer)
      )
    return { ...state, relay, socket, say }
  }
  type Fresh = Awaited<ReturnType<typeof fresh>>
  const auth = (secret: string) => JSON.stringify({ type: "auth", secret })
  const datafeed = JSON.stringify({ type: "datafeed", open: true })

  test("a valid auth makes the ingest a source that stores frames", async () => {
    const { relay, socket, say } = await fresh()
    say(auth(SECRET))
    say(datafeed)
    say(BATCH)

    expect(socket.closedWith).toBeNull()
    expect(relay.status()).toMatchObject({
      source: "extension",
      ingests: 1,
      trades: 1,
    })
  })

  test("before its auth, an ingest is not counted, not a source, and hears nothing", async () => {
    const { relay, socket } = await fresh()
    expect(relay.status()).toMatchObject({ source: "none", ingests: 0 })
    expect(socket.sent).toEqual([])
  })

  test("a wrong secret closes the socket, and it never counts", async () => {
    const { relay, socket, say } = await fresh()
    say(auth("wrong"))
    say(datafeed)
    say(BATCH)

    expect(socket.closedWith).toBe(4001)
    expect(relay.status()).toMatchObject({ ingests: 0, trades: 0 })
  })

  test("an auth with no secret closes the socket", async () => {
    const { socket, say } = await fresh()
    say(JSON.stringify({ type: "auth" }))
    expect(socket.closedWith).toBe(4001)
  })

  test("a first message that is not auth closes the socket", async () => {
    const { relay, socket, say } = await fresh()
    say(datafeed)
    expect(socket.closedWith).toBe(4001)
    expect(relay.status()).toMatchObject({ source: "none", ingests: 0 })
  })

  /** Valid JSON that is no object: null, a number, a string, an array. */
  const NON_OBJECTS = ["null", "5", '"auth"', "[]"]

  test.each(NON_OBJECTS)(
    "a first message of JSON %s closes the socket",
    async (message) => {
      const { relay, socket, say } = await fresh()
      say(message)
      expect(socket.closedWith).toBe(4001)
      expect(relay.status()).toMatchObject({ source: "none", ingests: 0 })
    }
  )

  test.each(NON_OBJECTS)(
    "after its auth, a message of JSON %s is ignored and the next frame is stored",
    async (message) => {
      const { relay, socket, say } = await fresh()
      say(auth(SECRET))
      say(datafeed)
      say(message)
      say(BATCH)
      expect(socket.closedWith).toBeNull()
      expect(relay.status()).toMatchObject({
        source: "extension",
        ingests: 1,
        trades: 1,
      })
    }
  )

  test("a frame sent before auth closes the socket and is never stored", async () => {
    const { relay, sql, socket, say } = await fresh()
    say(BATCH)
    say(auth(SECRET))

    expect(socket.closedWith).toBe(4001)
    expect(relay.status().trades).toBe(0)
    expect(relayStore(sql).symbolStates().toArray()).toEqual([])
  })

  /** What a refused socket may still have queued: its secret, then a `datafeed` and a frame. */
  const afterRefusal = async (relay: TradeRelay, state: Fresh) => {
    const say = (message: string | Uint8Array) =>
      relay.webSocketMessage(
        state.socket as unknown as WebSocket,
        typeof message === "string" ? message : (message.buffer as ArrayBuffer)
      )
    say(auth(SECRET))
    say(datafeed)
    say(BATCH)
    vi.advanceTimersByTime(AUTH_MS)
    await relay.alarm()
  }
  /** What a refusal must leave: no source, no count, nothing stored or sent. */
  const leftBehind = (relay: TradeRelay, state: Fresh) => {
    const { source, ingests, trades } = relay.status()
    return {
      closedWith: state.socket.closedWith,
      source,
      ingests,
      trades,
      stored: relayStore(state.sql).symbolStates().toArray(),
      sent: state.socket.sent,
    }
  }
  const refused = (code: number) => ({
    closedWith: code,
    source: "none",
    ingests: 0,
    trades: 0,
    stored: [],
    sent: [],
  })

  test.each([
    {
      by: "a wrong secret",
      code: 4001,
      refuse: (state: Fresh) => {
        state.say(auth("wrong"))
        return Promise.resolve()
      },
    },
    {
      by: "the auth deadline",
      code: 4002,
      refuse: async (state: Fresh) => {
        vi.advanceTimersByTime(AUTH_MS)
        await state.relay.alarm()
      },
    },
  ])(
    "a socket refused by $by stays refused: its secret, `datafeed` and frames are ignored",
    async ({ code, refuse }) => {
      const state = await fresh()
      await refuse(state)
      await afterRefusal(state.relay, state)
      expect(leftBehind(state.relay, state)).toEqual(refused(code))
    }
  )

  test("a refusal outlives a wake", async () => {
    const state = await fresh()
    state.say(auth("wrong"))

    const woken = new TradeRelay(state.ctx, ENV)
    await afterRefusal(woken, state)
    expect(leftBehind(woken, state)).toEqual(refused(4001))
  })

  test("an ingest that has not authenticated by the deadline is closed", async () => {
    const { relay, socket } = await fresh()
    vi.advanceTimersByTime(AUTH_MS - 1000)
    await relay.alarm()
    expect(socket.closedWith).toBeNull()

    vi.advanceTimersByTime(1000)
    await relay.alarm()
    expect(socket.closedWith).toBe(4002)
  })

  test("an authenticated ingest stays authenticated across a wake", async () => {
    const { ctx, socket, say } = await fresh()
    say(auth(SECRET))
    say(datafeed)
    vi.advanceTimersByTime(10_000)

    const woken = new TradeRelay(ctx, ENV)
    woken.webSocketMessage(
      socket as unknown as WebSocket,
      BATCH.buffer as ArrayBuffer
    )
    await woken.alarm()

    expect(socket.closedWith).toBeNull()
    expect(woken.status()).toMatchObject({ ingests: 1, trades: 1 })
  })
})

describe("an extension's reconnect", () => {
  const controls = (socket: FakeSocket) =>
    socket.sent
      .map((m) => (JSON.parse(m) as { type: string }).type)
      .filter((type) => type === "pause" || type === "resume")

  const reconnected = async (second: string | null) => {
    const state = objectState()
    const relay = new TradeRelay(state.ctx, ENV)
    const report = (socket: FakeSocket, install: string | null) =>
      relay.webSocketMessage(
        socket as unknown as WebSocket,
        JSON.stringify({ type: "datafeed", open: true, install })
      )
    const first = await state.openIngest(relay)
    report(first, "install-1")
    vi.advanceTimersByTime(1000)
    const next = await state.openIngest(relay)
    report(next, second)
    return { relay, first, next, sql: state.sql }
  }

  test("a new ingest from the active ingest's install becomes the active ingest as it reports its datafeed", async () => {
    const { first, next, sql } = await reconnected("install-1")
    expect(controls(first)).toEqual(["pause", "resume", "pause"])
    expect(controls(next)).toEqual(["pause", "resume"])
    expect(first.closedWith).toBe(4003)
    expect(next.closedWith).toBeNull()
    expect(
      relayStore(sql)
        .coverage()
        .map((c) => c.source)
    ).toEqual(["extension", "extension"])
  })

  test("its frames are the tape, and the old socket's are not", async () => {
    const { relay, first, next } = await reconnected("install-1")
    const frame = (tradeNumber: number) =>
      wireBatch([
        {
          stock: BBCA,
          time: NOW,
          tradeNumber,
          price: 9000,
          change: 50,
        },
      ]).buffer as ArrayBuffer
    relay.webSocketMessage(next as unknown as WebSocket, frame(1))
    relay.webSocketMessage(first as unknown as WebSocket, frame(2))
    expect(relay.backfill(BBCA).trades.map((t) => t.tradeNumber)).toEqual([1])
  })

  test("one from another install waits for the active ingest", async () => {
    const { first, next } = await reconnected("install-2")
    expect(controls(first)).toEqual(["pause", "resume"])
    expect(controls(next)).toEqual(["pause"])
    expect(first.closedWith).toBeNull()
  })

  test("one with no install waits for the active ingest", async () => {
    const { first, next } = await reconnected(null)
    expect(controls(first)).toEqual(["pause", "resume"])
    expect(controls(next)).toEqual(["pause"])
    expect(first.closedWith).toBeNull()
  })
})

describe("sweeps", () => {
  const SECOND = (s: number) =>
    `${TODAY}T03:00:${String(s).padStart(2, "0")}.000Z`

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** An order of `lots` lots at second `s`, as one trade. */
  const order = (tradeNumber: number, s: number, lots: number, board = 1) => ({
    stock: BBCA,
    time: SECOND(s),
    tradeNumber,
    volume: lots * 100,
    price: 665,
    value: lots * 100 * 665,
    board,
  })

  /** A relay whose BBCA threshold is 10 lots, from one closed order. */
  const settled = async () => {
    const relay = await started()
    relay.send(wireBatch([order(1, 1, 10), order(2, 2, 1)]))
    vi.advanceTimersByTime(1000)
    return relay
  }

  const sweepsIn = (socket: FakeSocket) =>
    socket.frames.flatMap((f) => (f.type === "sweep" ? [f.sweep] : []))

  test("a sweep is announced on crossing, grows, then closes, on one key", async () => {
    const { send, page } = await settled()
    const socket = await page()

    send(wireBatch([order(3, 3, 6)]))
    expect(sweepsIn(socket)).toEqual([])

    vi.advanceTimersByTime(100)
    send(wireBatch([order(4, 3, 6)]))
    vi.advanceTimersByTime(100)
    send(wireBatch([order(5, 3, 6)]))
    vi.advanceTimersByTime(100)
    send(wireBatch([order(6, 4, 1)]))

    const seen = sweepsIn(socket).filter((s) => s.firstNumber === 3)
    expect(seen.map((s) => [s.lots, s.freq, s.open, s.closedBy])).toEqual([
      [12, 2, true, null],
      [18, 3, true, null],
      [18, 3, false, "next-order"],
    ])
    expect(seen.map((s) => s.announcedAt)).toEqual(
      seen.map(() => seen[0]?.announcedAt)
    )
  })

  test("the row is stored with its threshold, and the backfill serves it", async () => {
    const { send, relay } = await settled()

    send(wireBatch([order(3, 3, 48)]))

    const { sweeps, threshold } = relay.backfill(BBCA)
    expect(sweeps).toEqual([
      expect.objectContaining({
        symbol: BBCA,
        firstNumber: 3,
        lots: 48,
        threshold: 10,
        warmingUp: true,
        prior: "none",
        board: "RG",
        open: true,
      }),
    ])
    expect(threshold).toMatchObject({ prior: "none", warmingUp: true })
    expect(relay.status().sweeps).toBe(sweeps.length)
  })

  test("a trades frame stays unflagged", async () => {
    const { send, page } = await settled()
    const socket = await page()

    send(wireBatch([order(3, 3, 48)]))

    const trades = socket.frames.flatMap((f) =>
      f.type === "trades" ? f.trades : []
    )
    expect(Object.keys(trades[0] ?? {}).sort()).toEqual(
      [
        "board",
        "change",
        "price",
        "receivedAt",
        "side",
        "symbol",
        "tradeNumber",
        "tradedAt",
        "value",
        "volume",
      ].sort()
    )
  })

  test("the row's frame comes after its batch's trades frame", async () => {
    const { send, page } = await settled()
    const socket = await page()

    send(wireBatch([order(3, 3, 48)]))

    const types = socket.frames.map((f) => f.type)
    expect(types.lastIndexOf("sweep")).toBeGreaterThan(
      types.lastIndexOf("trades")
    )
  })

  test("Stockbit's full resend adds nothing", async () => {
    const { send, relay, page } = await settled()
    const batch = wireBatch([order(3, 3, 48), order(4, 4, 1)])
    send(batch)
    const before = relay.backfill(BBCA).sweeps
    const socket = await page()
    const heard = sweepsIn(socket).length

    send(batch)

    expect(sweepsIn(socket).length).toBe(heard)
    expect(relay.backfill(BBCA).sweeps).toEqual(before)
  })

  test.each([
    ["TN", 2],
    ["NG", 3],
  ])("a %s trade never flags, and stays on the tape", async (_, board) => {
    const { send, relay } = await settled()

    send(wireBatch([order(3, 5, 1_000_000, board)]))

    expect(relay.backfill(BBCA).sweeps).toEqual([])
    expect(relay.backfill(BBCA).trades[0]?.tradeNumber).toBe(3)
  })

  test("a resume hears rows at `since` too, and an alarm closes an idle order", async () => {
    const { send, relay, open } = await settled()
    send(wireBatch([order(3, 3, 48)]))
    const { seq } = relay.status()

    vi.advanceTimersByTime(1000)
    await relay.alarm()

    const closed = relay.backfill(BBCA).sweeps[0]
    expect(closed).toMatchObject({ open: false, closedBy: "idle", seq })

    const socket = await open(
      relay,
      `${TRADES_PATH}?${TRADES_QUERY.symbol}=${BBCA}&${TRADES_QUERY.since}=${seq}`
    )
    expect(sweepsIn(socket)).toEqual([closed])
  })

  test("a resume past the row's seq does not hear it", async () => {
    const { send, relay, open } = await settled()
    send(wireBatch([order(3, 3, 48)]))
    const { seq } = relay.status()

    const socket = await open(
      relay,
      `${TRADES_PATH}?${TRADES_QUERY.symbol}=${BBCA}&${TRADES_QUERY.since}=${seq + 1}`
    )
    expect(sweepsIn(socket)).toEqual([])
  })

  test("a new page hears the threshold when it opens", async () => {
    const { page } = await settled()
    const socket = await page()
    expect(socket.frames.filter((f) => f.type === "threshold")).toEqual([
      expect.objectContaining({
        threshold: expect.objectContaining({ symbol: BBCA, ordersToday: 1 }),
      }),
    ])
  })

  test("a threshold frame goes at most once per 10 s, and its last change still goes", async () => {
    const { send, relay, page } = await settled()
    const socket = await page()
    const thresholds = () =>
      socket.frames.flatMap((f) =>
        f.type === "threshold" ? [f.threshold.ordersToday] : []
      )
    send(wireBatch([order(3, 3, 1)]))
    vi.advanceTimersByTime(1000)
    send(wireBatch([order(4, 4, 1)]))
    vi.advanceTimersByTime(1000)
    send(wireBatch([order(5, 5, 1)]))
    // One when the page opened, and one for the first change: the next two wait.
    expect(thresholds()).toEqual([1, 2])

    vi.advanceTimersByTime(11_000)
    await relay.alarm()

    // The alarm's idle close of the last order is the fifth.
    expect(thresholds()).toEqual([1, 2, 5])
  })

  test("a new day clears the rows", async () => {
    const { send, relay } = await settled()
    send(wireBatch([order(3, 3, 48)]))

    vi.setSystemTime(new Date(`${TOMORROW}T03:00:00.000Z`))
    send(wireBatch([{ ...order(1, 1, 1), time: `${TOMORROW}T03:00:01.000Z` }]))

    expect(relay.backfill(BBCA).sweeps).toEqual([])
    expect(relay.status().sweeps).toBe(0)
    expect(relay.backfill(BBCA).threshold.ordersToday).toBe(0)
  })

  test("a wake still counts the day's rows", async () => {
    const { send, relay, ctx } = await settled()
    send(wireBatch([order(3, 3, 48)]))
    expect(relay.status().sweeps).toBe(1)

    const woken = new TradeRelay(ctx, ENV)
    expect(woken.status().sweeps).toBe(1)
  })

  describe("across a restart", () => {
    const sketchRows = (sql: SqlStorage) =>
      sql
        .exec<{ day: string; symbol: string; n: number }>(
          "SELECT day, symbol, n FROM sketches ORDER BY day, symbol"
        )
        .toArray()

    const wake = (ctx: DurableObjectState) => new TradeRelay(ctx, ENV)

    const deliver = (
      relay: TradeRelay,
      ingest: FakeSocket,
      bytes: Uint8Array
    ) =>
      relay.webSocketMessage(
        ingest as unknown as WebSocket,
        bytes.buffer as ArrayBuffer
      )

    test("the alarm flushes the dirty sketches and the market's sum", async () => {
      const { relay, sql } = await settled()
      await relay.alarm()
      expect(sketchRows(sql)).toEqual([
        { day: TODAY, symbol: "*", n: 2 },
        { day: TODAY, symbol: BBCA, n: 2 },
      ])
    })

    test("an order closed by an alarm stays closed through a rebuild, on the row it wrote", async () => {
      const { relay, send, ctx, sql } = await settled()
      send(wireBatch([order(3, 3, 48)]))
      vi.advanceTimersByTime(1000)
      await relay.alarm()
      const closed = relayStore(sql)
        .sweepsOf(TODAY, BBCA)
        .find((s) => s.firstNumber === 3)
      expect(closed).toMatchObject({ open: false, closedBy: "idle" })

      vi.advanceTimersByTime(60_000)
      const woken = wake(ctx)

      expect(
        relayStore(sql)
          .sweepsOf(TODAY, BBCA)
          .find((s) => s.firstNumber === 3)
      ).toEqual(closed)
      expect(woken.backfill(BBCA).threshold.ordersToday).toBe(3)
    })

    test("the active ingest's close flushes", async () => {
      const { relay, sql, ingest } = await settled()
      relay.webSocketClose(ingest as unknown as WebSocket, 1006)
      expect(sketchRows(sql)).toEqual([
        { day: TODAY, symbol: "*", n: 1 },
        { day: TODAY, symbol: BBCA, n: 1 },
      ])
    })

    test("another ingest's close does not", async () => {
      const { relay, sql, openIngest } = await settled()
      const second = await openIngest(relay)
      relay.webSocketClose(second as unknown as WebSocket, 1006)
      expect(sketchRows(sql)).toEqual([])
    })

    test("the own session stopping being live flushes", async () => {
      const { relay, sql } = await settled()
      // Only the state's change matters here, and a real one needs Stockbit's socket.
      const { ownSession } = relay as unknown as {
        ownSession: {
          machine: { state: string }
          deps: { onChange: () => void }
        }
      }
      ownSession.machine = { state: "live" }
      ownSession.deps.onChange()
      expect(sketchRows(sql)).toEqual([])

      ownSession.machine = { state: "backoff" }
      ownSession.deps.onChange()
      expect(sketchRows(sql)).toEqual([
        { day: TODAY, symbol: "*", n: 1 },
        { day: TODAY, symbol: BBCA, n: 1 },
      ])
    })

    test("a rebuild sends nothing, keeps the key, and the order goes on growing", async () => {
      const { send, relay, ctx, ingest, page } = await settled()
      const socket = await page()
      send(wireBatch([order(3, 3, 48)]))
      relay.webSocketClose(ingest as unknown as WebSocket, 1006)
      const row = relay.backfill(BBCA).sweeps
      const heard = socket.sent.length
      const toIngest = ingest.sent.length

      const woken = wake(ctx)

      expect(socket.sent.length).toBe(heard)
      expect(ingest.sent.length).toBe(toIngest)
      expect(woken.backfill(BBCA).sweeps).toEqual(row)
      expect(woken.status().sweeps).toBe(1)

      deliver(woken, ingest, wireBatch([order(4, 3, 2)]))

      expect(woken.backfill(BBCA).sweeps).toEqual([
        expect.objectContaining({
          firstNumber: 3,
          lastNumber: 4,
          lots: 50,
          freq: 2,
          open: true,
          announcedAt: row[0]?.announcedAt,
        }),
      ])
      expect(woken.status().sweeps).toBe(1)
    })

    test("a batch after the last flush is replayed into the sketch", async () => {
      const { send, relay, ctx } = await settled()
      await relay.alarm()
      send(wireBatch([order(3, 3, 5), order(4, 4, 6)]))

      const woken = wake(ctx)

      // The second order of `settled`, and the one the second trade closed.
      expect(woken.backfill(BBCA).threshold.ordersToday).toBe(3)
    })

    test("a symbol quiet since the morning does not widen the replay", async () => {
      const { send, relay, ctx, sql } = await settled()
      await relay.alarm()
      const { seq } = relay.status()
      send(wireBatch([order(3, 3, 5)]))
      vi.advanceTimersByTime(1000)
      await relay.alarm()
      send(wireBatch([{ ...order(4, 4, 5), stock: TLKM }]))

      const exec = vi.spyOn(sql, "exec")
      wake(ctx)

      const reads = exec.mock.calls.filter(([query]) =>
        /\bFROM tape\b/.test(query)
      )
      expect(reads.map(([, ...params]) => params)).toEqual([[TLKM, seq + 2]])
      exec.mockRestore()
      for (const [query, ...params] of reads) {
        const plan = sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...params)
          .toArray()
          .map((row) => row.detail)
          .join()
        expect(plan).not.toContain("SCAN")
      }
    })

    const tapeReads = (spy: { mock: { calls: Array<Array<unknown>> } }) =>
      spy.mock.calls
        .filter(([query]) => /\bFROM tape\b/.test(String(query)))
        .map(([, ...params]) => params)

    test("a first batch is replayed by a wake before any flush", async () => {
      const { ctx } = await settled()
      expect(wake(ctx).backfill(BBCA).threshold.ordersToday).toBe(1)
    })

    test("a sweep announced before any flush goes on growing after a wake", async () => {
      const { send, ctx, ingest, relay } = await settled()
      send(wireBatch([order(3, 3, 48)]))
      const [row] = relay.backfill(BBCA).sweeps

      const woken = wake(ctx)
      deliver(woken, ingest, wireBatch([order(4, 3, 2)]))

      expect(woken.backfill(BBCA).sweeps).toEqual([
        expect.objectContaining({
          firstNumber: 3,
          lastNumber: 4,
          lots: 50,
          freq: 2,
          open: true,
          announcedAt: row?.announcedAt,
        }),
      ])
    })

    test("a wake with no day yet leaves a boundary its first batch replays from", async () => {
      const { ctx, ingest } = await started()
      const woken = wake(ctx)
      deliver(woken, ingest, wireBatch([order(1, 1, 10), order(2, 2, 1)]))
      expect(wake(ctx).backfill(BBCA).threshold.ordersToday).toBe(1)
    })

    test("a wake with no replay point keeps the older tape out of every later wake", async () => {
      const { ctx, sql, ingest, relay } = await settled()
      const { seq } = relay.status()
      ctx.storage.kv.delete(WHALE_REPLAY_KEY)

      const woken = wake(ctx)
      deliver(woken, ingest, wireBatch([order(3, 3, 5), order(4, 4, 6)]))

      const laterWake = vi.spyOn(sql, "exec")
      const again = wake(ctx)
      expect(tapeReads(laterWake)).toEqual([[BBCA, seq + 1]])
      laterWake.mockRestore()
      // The order the second trade closed. The rows before the first wake stay out.
      expect(again.backfill(BBCA).threshold.ordersToday).toBe(1)
    })

    test("with no replay point stored, a wake reads no tape, takes new trades, and its next flush moves the boundary", async () => {
      const { ctx, sql, ingest } = await settled()
      ctx.storage.kv.delete(WHALE_REPLAY_KEY)

      const firstWake = vi.spyOn(sql, "exec")
      const woken = wake(ctx)
      expect(tapeReads(firstWake)).toEqual([])
      firstWake.mockRestore()

      deliver(woken, ingest, wireBatch([order(3, 3, 5), order(4, 4, 6)]))
      expect(woken.backfill(BBCA).trades.map((t) => t.tradeNumber)).toEqual(
        expect.arrayContaining([3, 4])
      )
      // The order the second trade closed. The rows before this wake stay out.
      expect(woken.backfill(BBCA).threshold.ordersToday).toBe(1)

      vi.advanceTimersByTime(1000)
      await woken.alarm()
      const { seq } = woken.status()
      deliver(woken, ingest, wireBatch([order(5, 5, 7)]))

      const secondWake = vi.spyOn(sql, "exec")
      wake(ctx)
      expect(tapeReads(secondWake)).toEqual([[BBCA, seq + 1]])
      secondWake.mockRestore()
    })
  })

  describe("the day clear", () => {
    const NEXT_DAY = `${TOMORROW}T03:00:00.000Z`

    const nextDay = async () => {
      const relay = await settled()
      // Still open at the clear, and TLKM never trades.
      relay.send(wireBatch([order(3, 3, 48)]))
      vi.setSystemTime(new Date(NEXT_DAY))
      relay.send(
        wireBatch([{ ...order(1, 1, 1), time: `${TOMORROW}T03:00:01.000Z` }])
      )
      return relay
    }

    test("the new session reads `own` for a symbol that traded, `market` for one that did not", async () => {
      const { relay } = await nextDay()

      expect(relay.backfill(BBCA).threshold.prior).toBe("own")
      expect(relay.backfill(TLKM).threshold).toMatchObject({
        prior: "market",
        warmingUp: true,
        ordersToday: 0,
      })
    })

    test("the open order at the end went into the ended session's sketch, plus `*`", async () => {
      const { sql } = await nextDay()

      expect(
        sql
          .exec<{ day: string; symbol: string; n: number }>(
            "SELECT day, symbol, n FROM sketches ORDER BY symbol"
          )
          .toArray()
      ).toEqual([
        { day: TODAY, symbol: "*", n: 3 },
        { day: TODAY, symbol: BBCA, n: 3 },
      ])
    })

    test("the session before the ended one goes", async () => {
      const relay = await started()
      relayStore(relay.sql).upsertSketch(BBCA, YESTERDAY, sketchOf([1]))
      relay.send(wireBatch([order(1, 1, 1), order(2, 2, 1)]))
      vi.setSystemTime(new Date(NEXT_DAY))
      relay.send(
        wireBatch([{ ...order(1, 1, 1), time: `${TOMORROW}T03:00:01.000Z` }])
      )

      expect(
        relay.sql
          .exec<{ day: string }>("SELECT DISTINCT day FROM sketches")
          .toArray()
      ).toEqual([{ day: TODAY }])
    })

    test("the prior holds across a wake, and no ended session's sketch counts as today's", async () => {
      const { ctx, relay } = await nextDay()
      vi.advanceTimersByTime(1000)
      await relay.alarm()

      const woken = new TradeRelay(ctx, ENV)

      expect(woken.backfill(BBCA).threshold).toMatchObject({
        prior: "own",
        ordersToday: 1,
      })
      expect(woken.backfill(TLKM).threshold.prior).toBe("market")
    })

    test("a quiet symbol's page hears its new session's threshold after the day-clearing status", async () => {
      const relay = await settled()
      relay.send(wireBatch([order(3, 3, 48)]))
      const socket = await relay.page(TLKM)
      socket.frames.length = 0
      vi.setSystemTime(new Date(NEXT_DAY))
      relay.send(
        wireBatch([{ ...order(1, 1, 1), time: `${TOMORROW}T03:00:01.000Z` }])
      )

      const clearing = socket.frames.findIndex(
        (f) => f.type === "status" && f.status.day === TOMORROW
      )
      expect(clearing).toBeGreaterThanOrEqual(0)
      expect(
        socket.frames
          .slice(clearing + 1)
          .flatMap((f) => (f.type === "threshold" ? [f.threshold] : []))
          .at(-1)
      ).toMatchObject({ symbol: TLKM, prior: "market", ordersToday: 0 })
    })

    test("the first day ever has no prior", async () => {
      const relay = await settled()
      expect(relay.relay.backfill(BBCA).threshold.prior).toBe("none")
    })
  })
})

describe("walls", () => {
  const SECOND = (s: number) =>
    `${TODAY}T03:00:${String(s).padStart(2, "0")}.000Z`
  const ORDER = "202610290002329192"
  const matchOf = (tradeNumber: number, day = "20261029") =>
    `${day}${String(tradeNumber).padStart(10, "0")}`

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const trade = (
    tradeNumber: number,
    over: { price?: number; board?: number; lots?: number; s?: number } = {}
  ) => ({
    stock: BBCA,
    time: SECOND(over.s ?? 3),
    tradeNumber,
    volume: (over.lots ?? 1) * 100,
    price: over.price ?? 5050,
    value: 1,
    board: over.board ?? 1,
  })

  const hit = (
    tradeNumber: number,
    over: { lots?: number; day?: string; date?: string } = {}
  ) =>
    wireLivePrice({
      stock: BBCA,
      date: over.date ?? `${TODAY}T10:00:00.000`,
      volume: 100,
      lastprice: 5050,
      verb: "S",
      quantity: (over.lots ?? 20) * 100,
      orderNumber: ORDER,
      matchNumber: matchOf(tradeNumber, over.day),
    })

  /** A relay whose BBCA threshold is 10 lots, from one closed order. */
  const settled = async () => {
    const relay = await started()
    relay.send(
      wireBatch([trade(1, { lots: 10, s: 1 }), trade(2, { lots: 1, s: 2 })])
    )
    vi.advanceTimersByTime(1000)
    return relay
  }

  const wallsIn = (socket: FakeSocket) =>
    socket.frames.flatMap((f) => (f.type === "wall" ? [f.wall] : []))

  test("a hit that crosses is stored and sent on the walls' own feed", async () => {
    const { send, page, relay } = await settled()
    const socket = await page()

    send(hit(3))
    expect(wallsIn(socket)).toEqual([])
    send(wireBatch([trade(3)]))

    expect(wallsIn(socket)).toMatchObject([
      {
        firstOrderNumber: ORDER,
        memberOrderNumbers: [ORDER],
        side: "offer",
        price: 5050,
        hitsSeen: 1,
        lotsMatched: 20,
        threshold: 10,
      },
    ])
    expect(socket.frames.find((f) => f.type === "wall")).toMatchObject({
      provenance: { feed: "stockbit-liveprice" },
      threshold: { symbol: BBCA, threshold: 10 },
    })
    expect(relay.status().walls).toBe(1)
    expect(relay.backfill(BBCA).walls).toMatchObject([
      { firstOrderNumber: ORDER, memberOrderNumbers: [ORDER], hitsSeen: 1 },
    ])
  })

  test("a TN or NG hit does not count, and a frame with no trade after 5 s does", async () => {
    const { send, page, relay } = await settled()
    const socket = await page()

    send(hit(3))
    send(wireBatch([trade(3, { board: 3 })]))
    send(hit(4))
    send(wireBatch([trade(4, { board: 2 })]))
    await relay.alarm()
    vi.advanceTimersByTime(6000)
    await relay.alarm()
    expect(wallsIn(socket)).toEqual([])

    send(hit(5))
    vi.advanceTimersByTime(6000)
    await relay.alarm()
    expect(wallsIn(socket)).toMatchObject([{ hitsSeen: 1 }])
  })

  test("a hit counts even when its frame leaves the quote unchanged", async () => {
    const { send, relay } = await settled()
    const date = `${TODAY}T10:00:00.000`
    send(hit(3, { date }))
    // Older than what the quote already holds, so the fold drops it.
    send(hit(4, { date: `${TODAY}T09:00:00.000` }))
    send(wireBatch([trade(3), trade(4)]))
    expect(relay.backfill(BBCA).walls[0]?.hitsSeen).toBe(2)
  })

  test("a frame from another day counts for nothing, and still moves nothing", async () => {
    const { send, relay } = await settled()
    send(hit(3, { day: "20261028" }))
    vi.advanceTimersByTime(6000)
    await relay.alarm()
    expect(relay.backfill(BBCA).walls).toEqual([])
  })

  test("a wall gone by idle goes traded-through on a later trade through its price, on the page and on its row", async () => {
    const { send, page, relay } = await settled()
    const socket = await page()
    send(hit(3))
    send(wireBatch([trade(3)]))
    vi.advanceTimersByTime(61_000)
    await relay.alarm()
    expect(wallsIn(socket).at(-1)?.closedBy).toBe("idle")

    vi.advanceTimersByTime(1000)
    const tradedAt = new Date().toISOString()
    send(wireBatch([trade(9, { price: 5075, s: 5 })]))
    expect(wallsIn(socket).at(-1)).toMatchObject({
      closedBy: "traded-through",
      closedAt: tradedAt,
    })
    expect(relay.backfill(BBCA).walls[0]).toMatchObject({
      closedBy: "traded-through",
      closedAt: tradedAt,
    })
  })

  test("an NG trade through the price does not close a wall, and an RG trade does", async () => {
    const { send, page, relay } = await settled()
    const socket = await page()
    send(hit(3))
    send(wireBatch([trade(3)]))

    send(wireBatch([trade(4, { price: 9000, board: 2 })]))
    expect(relay.backfill(BBCA).walls[0]?.closedAt).toBeNull()

    send(wireBatch([trade(5, { price: 5075 })]))
    expect(wallsIn(socket).at(-1)).toMatchObject({
      closedBy: "traded-through",
    })
    expect(relay.backfill(BBCA).walls[0]?.closedBy).toBe("traded-through")
  })

  test("a wall goes after 60 s with no hit", async () => {
    const { send, relay } = await settled()
    send(hit(3))
    send(wireBatch([trade(3)]))
    vi.advanceTimersByTime(60_001)
    await relay.alarm()
    expect(relay.backfill(BBCA).walls[0]?.closedBy).toBe("idle")
  })

  test("a restart restores announced walls and they keep counting", async () => {
    const { send, ctx, relay } = await settled()
    send(hit(3))
    send(wireBatch([trade(3)]))
    send(hit(4))
    send(wireBatch([trade(4)]))
    expect(relay.status().walls).toBe(1)

    const woken = new TradeRelay(ctx, ENV)
    expect(woken.status().walls).toBe(1)
    const ingest = ctx.getWebSockets("ingest")[0]
    if (!ingest) throw new Error("no ingest")
    const sendAgain = (bytes: Uint8Array) =>
      woken.webSocketMessage(ingest, bytes.buffer as ArrayBuffer)
    sendAgain(hit(5))
    sendAgain(wireBatch([trade(5)]))

    expect(woken.backfill(BBCA).walls).toMatchObject([
      { firstOrderNumber: ORDER, hitsSeen: 3, lotsMatched: 60 },
    ])
  })

  test("a page resuming hears a wall changed at its own seq", async () => {
    const { send, open, relay } = await settled()
    send(hit(3))
    send(wireBatch([trade(3)]))
    const { seq } = relay.status()
    send(hit(4))
    vi.advanceTimersByTime(6000)
    await relay.alarm()

    const socket = await open(
      relay,
      `${TRADES_PATH}?${TRADES_QUERY.symbol}=${BBCA}&${TRADES_QUERY.since}=${seq}`
    )
    expect(wallsIn(socket)).toMatchObject([{ hitsSeen: 2 }])
  })

  test("the day clear drops the walls and their memory", async () => {
    const { send, relay } = await settled()
    send(hit(3))
    send(wireBatch([trade(3)]))

    send(
      wireBatch([
        { stock: BBCA, time: `${TOMORROW}T03:00:00.000Z`, tradeNumber: 1 },
      ])
    )

    expect(relay.status().walls).toBe(0)
    expect(relay.backfill(BBCA).walls).toEqual([])
  })

  describe("the coverage and the pill", () => {
    test("an open page is in the wall coverage, and receiving once a frame arrives", async () => {
      const { send, page, relay } = await settled()
      expect(relay.status().wallCoverage).toEqual([])

      await page()
      expect(relay.status().wallCoverage).toEqual([
        { symbol: BBCA, receiving: false },
      ])
      expect(relay.backfill(BBCA).wallCoverage).toBe(true)

      send(hit(3))
      expect(relay.status().wallCoverage).toEqual([
        { symbol: BBCA, receiving: true },
      ])

      vi.advanceTimersByTime(60_001)
      expect(relay.status().wallCoverage).toEqual([
        { symbol: BBCA, receiving: false },
      ])
    })

    test("a symbol with no page reads as covered while the wall coverage has room", async () => {
      const { relay } = await settled()
      expect(relay.backfill(TLKM).wallCoverage).toBe(true)
    })

    const symbols = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, i) =>
        Symbol.make(
          `${prefix}${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`
        )
      )

    const covered = (relay: TradeRelay) =>
      relay.status().wallCoverage.map((c) => c.symbol)

    /** Every wall coverage the ingest was sent, oldest first, once the debounce has passed. */
    const coverageSent = (ingest: FakeSocket) => {
      vi.advanceTimersByTime(500)
      return ingest.sent.flatMap((message) => {
        const c = JSON.parse(message) as IngestControl
        return c.type === "liveprice" ? [c.symbols] : []
      })
    }

    test("a watchlist replaces the symbols and reaches the active ingest", async () => {
      const { relay, ingest } = await settled()
      relay.setWallSymbols([TLKM, BBCA])
      expect(covered(relay)).toEqual([BBCA, TLKM])
      expect(coverageSent(ingest).at(-1)).toEqual([BBCA, TLKM])

      relay.setWallSymbols([TLKM])
      expect(covered(relay)).toEqual([TLKM])
      expect(coverageSent(ingest).at(-1)).toEqual([TLKM])
    })

    test("open pages stay in the wall coverage ahead of the watchlists, and leave it to them", async () => {
      const { relay, page } = await settled()
      relay.setWallSymbols(symbols(50, "AA"))
      expect(covered(relay)).toEqual(symbols(50, "AA"))

      const socket = await page(Symbol.make("ZZZZ"))
      expect(covered(relay)).toEqual([
        Symbol.make("ZZZZ"),
        ...symbols(49, "AA"),
      ])

      socket.readyState = WebSocket.CLOSED
      relay.webSocketClose(socket as unknown as WebSocket, 1000)
      expect(covered(relay)).toEqual(symbols(50, "AA"))
    })

    test("a watched symbol's frames count as hits with no page open", async () => {
      const { relay, send } = await settled()
      relay.setWallSymbols([BBCA])
      send(hit(3))
      send(wireBatch([trade(3)]))
      expect(relay.status().walls).toBe(1)
      expect(relay.status().wallCoverage).toEqual([
        { symbol: BBCA, receiving: true },
      ])
    })

    test("the watched symbols survive a restart, on a relay with no day", async () => {
      const { ctx, relay } = await started()
      relay.setWallSymbols([TLKM, BBCA])
      const woken = new TradeRelay(ctx, ENV)
      expect(woken.status().day).toBeNull()
      expect(covered(woken)).toEqual([BBCA, TLKM])
    })

    test("the watched symbols survive the day clear and a restart after it", async () => {
      const { ctx, relay, send } = await settled()
      relay.setWallSymbols([TLKM])
      send(
        wireBatch([
          { stock: BBCA, time: `${TOMORROW}T03:00:00.000Z`, tradeNumber: 1 },
        ])
      )
      expect(relay.status().day).toBe(TOMORROW)
      expect(covered(relay)).toEqual([TLKM])
      expect(covered(new TradeRelay(ctx, ENV))).toEqual([TLKM])
    })

    test("a page hears the wall coverage change, and hears nothing when it has not", async () => {
      const { relay, page } = await settled()
      const socket = await page()
      const statuses = () =>
        socket.frames.filter((f) => f.type === "status").length

      const before = statuses()
      relay.setWallSymbols([TLKM])
      expect(statuses()).toBe(before + 1)
      expect(socket.frames.at(-1)).toMatchObject({
        status: { wallCoverage: [{ symbol: BBCA }, { symbol: TLKM }] },
      })

      relay.setWallSymbols([TLKM])
      expect(statuses()).toBe(before + 1)
    })

    describe("a first paint, which reads what the page's own socket will make of the wall coverage", () => {
      test("a wall coverage full of watched symbols still covers the page, which goes ahead of them", async () => {
        const { relay, page } = await settled()
        relay.setWallSymbols(symbols(50, "AA"))
        expect(relay.backfill(TLKM).wallCoverage).toBe(true)

        await page(TLKM)
        expect(covered(relay)).toContain(TLKM)
      })

      test("a wall coverage full of open pages does not cover one sorting after them", async () => {
        const { relay, page } = await settled()
        for (const symbol of symbols(50, "AA")) await page(symbol)
        const late = Symbol.make("ZZZZ")
        expect(relay.backfill(late).wallCoverage).toBe(false)

        await page(late)
        expect(covered(relay)).not.toContain(late)
      })

      test("a wall coverage full of open pages takes one sorting among them", async () => {
        const { relay, page } = await settled()
        for (const symbol of symbols(50, "BB")) await page(symbol)
        const early = Symbol.make("AAAA")
        expect(relay.backfill(early).wallCoverage).toBe(true)

        await page(early)
        expect(covered(relay)).toContain(early)
      })
    })

    test("liveprice is live while any frame arrived in the last 60 s, apart from the tape", async () => {
      const { send, relay } = await settled()
      relay.setWallSymbols([BBCA])
      expect(relay.backfill(BBCA).provenance.freshness).toBe("live")
      expect(relay.backfill(BBCA).liveprice.freshness).toBe("stale")

      send(hit(3))
      vi.advanceTimersByTime(59_000)
      send(hit(4))
      // A frame is enough for the walls' feed, a quiet tape or not.
      expect(relay.backfill(BBCA).liveprice).toMatchObject({
        feed: "stockbit-liveprice",
        freshness: "live",
      })
      vi.advanceTimersByTime(2000)
      expect(relay.backfill(BBCA).provenance.freshness).toBe("stale")
      expect(relay.backfill(TLKM).liveprice.freshness).toBe("live")

      vi.advanceTimersByTime(60_000)
      expect(relay.backfill(BBCA).liveprice.freshness).toBe("stale")
    })

    describe("a frame for a symbol out of the wall coverage", () => {
      const tlkmFrame = () =>
        wireLivePrice({
          stock: TLKM,
          date: `${TODAY}T10:00:00.000`,
          volume: 100,
        })

      test("does not make the walls' feed live on a backfill or the radar's first paint", async () => {
        const { send, relay } = await settled()
        relay.setWallSymbols([BBCA])
        send(tlkmFrame())

        expect(relay.backfill(BBCA).liveprice).toMatchObject({
          freshness: "stale",
          asOf: null,
        })
        expect(relay.today().liveprice).toMatchObject({
          freshness: "stale",
          asOf: null,
        })
        expect(relay.status().wallCoverage).toEqual([
          { symbol: BBCA, receiving: false },
        ])
      })

      test("does not make a wall frame's feed live", async () => {
        const { send, page } = await settled()
        const socket = await page()
        send(hit(3))
        send(wireBatch([trade(3)]))
        vi.advanceTimersByTime(61_000)
        send(tlkmFrame())

        send(wireBatch([trade(9, { price: 5075, s: 5 })]))
        expect(
          socket.frames.filter((f) => f.type === "wall").at(-1)
        ).toMatchObject({
          provenance: { feed: "stockbit-liveprice", freshness: "stale" },
        })
      })

      test("does not hide a covered symbol's return from a page with no wall", async () => {
        const { send, page } = await settled()
        const socket = await page()
        send(tlkmFrame())
        send(hit(3))

        const statuses = socket.frames.flatMap((f) =>
          f.type === "status" ? [f.status] : []
        )
        expect(statuses.at(-1)?.wallCoverage).toEqual([
          { symbol: BBCA, receiving: true },
        ])
      })

      test("still moves the live quote of a page past the coverage's cap", async () => {
        const { send, page, relay } = await settled()
        for (const symbol of symbols(50, "AA")) await page(symbol)
        const late = Symbol.make("ZZZZ")
        const socket = await page(late)
        expect(covered(relay)).not.toContain(late)

        const quotedAt = new Date().toISOString()
        send(
          wireLivePrice({
            stock: late,
            date: `${TODAY}T10:00:00.000`,
            volume: 100_000,
          })
        )

        expect(quoteFrames(socket.frames).at(-1)).toMatchObject({
          symbol: late,
          quote: { volumeLot: 1000 },
          provenance: { asOf: quotedAt },
        })
        expect(relay.backfill(late).quoteAsOf).toBe(quotedAt)
      })
    })

    test("a page hears the walls' feed start and stop by itself", async () => {
      const { send, page, relay } = await settled()
      const socket = await page()
      const receiving = () =>
        socket.frames
          .flatMap((f) => (f.type === "status" ? [f.status] : []))
          .at(-1)?.wallCoverage[0]?.receiving

      send(hit(3))
      expect(receiving()).toBe(true)

      vi.advanceTimersByTime(61_000)
      await relay.alarm()
      expect(receiving()).toBe(false)
    })
  })
})

describe("the market socket", () => {
  const SECOND = (s: number) =>
    `${TODAY}T03:00:${String(s).padStart(2, "0")}.000Z`

  /** An order of `lots` lots on `stock` at second `s`, as one trade. */
  const order = (
    stock: Symbol,
    tradeNumber: number,
    s: number,
    lots: number
  ) => ({
    stock,
    time: SECOND(s),
    tradeNumber,
    volume: lots * 100,
    price: 100,
    value: lots * 100 * 100,
  })

  /** BBCA's and TLKM's thresholds are 10 lots, from one closed order each. */
  const settled = async () => {
    const relay = await started()
    relay.send(
      wireBatch([
        order(BBCA, 1, 1, 10),
        order(BBCA, 2, 2, 1),
        order(TLKM, 1, 1, 10),
        order(TLKM, 2, 2, 1),
      ])
    )
    vi.advanceTimersByTime(1000)
    return {
      ...relay,
      market: (since?: number) =>
        relay.open(
          relay.relay,
          `${TRADES_PATH}?${TRADES_QUERY.symbol}=${MARKET}${since === undefined ? "" : `&${TRADES_QUERY.since}=${since}`}`
        ),
    }
  }

  const rows = (socket: FakeSocket) =>
    socket.frames.flatMap((f) => (f.type === "sweep" ? [f.sweep] : []))

  test("hears flagged rows and status across symbols, never trades", async () => {
    const { send, market } = await settled()
    const socket = await market()

    send(wireBatch([order(BBCA, 3, 3, 48)]))
    vi.advanceTimersByTime(100)
    send(wireBatch([order(TLKM, 3, 3, 48), order(TLKM, 4, 4, 1)]))

    expect(rows(socket).map((s) => s.symbol)).toEqual(
      expect.arrayContaining([BBCA, TLKM])
    )
    const types = new Set(socket.frames.map((f) => f.type))
    expect(types.has("status")).toBe(true)
    expect(types.has("trades")).toBe(false)
    expect(types.has("quote")).toBe(false)
  })

  test("hears the threshold frames of every symbol", async () => {
    const { send, market } = await settled()
    const socket = await market()

    send(wireBatch([order(TLKM, 3, 3, 1), order(BBCA, 3, 3, 1)]))

    expect(
      socket.frames.flatMap((f) =>
        f.type === "threshold" ? [f.threshold.symbol] : []
      )
    ).toEqual(expect.arrayContaining([BBCA, TLKM]))
  })

  test("is tagged market and stays out of the wall coverage", async () => {
    const { ingest, market, page } = await settled()
    await market()
    vi.advanceTimersByTime(600)
    const coverages = () =>
      ingest.sent.flatMap((m) => {
        const c = JSON.parse(m) as { type: string; symbols?: Array<string> }
        return c.type === "liveprice" ? [c.symbols] : []
      })
    expect(coverages().every((symbols) => symbols?.length === 0)).toBe(true)

    await page(TLKM)
    vi.advanceTimersByTime(600)
    expect(coverages().at(-1)).toEqual([TLKM])
  })

  test("counts as a client, so the alarm keeps it alive", async () => {
    const { relay, market } = await settled()
    await market()
    expect(relay.status().clients).toBe(1)
  })

  test("a resume hears a row closed by idleness without a seq bump", async () => {
    const { send, relay, market } = await settled()
    send(wireBatch([order(BBCA, 3, 3, 48)]))
    const { seq } = relay.status()

    vi.advanceTimersByTime(1000)
    await relay.alarm()

    expect(relay.status().seq).toBe(seq)
    expect(rows(await market(seq))).toEqual([
      expect.objectContaining({
        firstNumber: 3,
        open: false,
        closedBy: "idle",
        seq,
      }),
    ])
    expect(rows(await market(seq + 1))).toEqual([])
  })

  test("a resume is the newest 500 at most, newest first", async () => {
    const { sql, market } = await settled()
    const store = relayStore(sql)
    for (let n = 1; n <= 501; n++)
      store.upsertSweep(storedSweep({ firstNumber: n, at: n }))

    const heard = rows(await market(0))

    expect(heard).toHaveLength(500)
    expect(heard[0]?.firstNumber).toBe(501)
    expect(heard.at(-1)?.firstNumber).toBe(2)
  })

  test("today serves the newest 500, the total, and totals from every row", async () => {
    const { ctx, sql, relay } = await settled()
    const store = relayStore(sql)
    for (let n = 1; n <= 501; n++)
      store.upsertSweep(storedSweep({ firstNumber: n, at: n, value: 100 }))
    store.upsertSweep(
      storedSweep({
        firstNumber: 900,
        at: 900,
        symbol: TLKM,
        side: "sell",
        value: 7,
      })
    )
    // A wake, which reads the count the rows above went around.
    const fresh = new TradeRelay(ctx, ENV)

    const today = fresh.today()

    expect(today.sweeps).toHaveLength(500)
    expect(today.sweeps[0]?.firstNumber).toBe(900)
    expect(today.sweepsTotal).toBe(502)
    expect(today.day).toBe(TODAY)
    expect(today.seq).toBe(relay.status().seq)
    // All 501 of BBCA's rows, though only 499 of them are in the page.
    expect(today.leaderboard).toEqual([
      { symbol: BBCA, buyValue: 50_100, sellValue: 0 },
      { symbol: TLKM, buyValue: 0, sellValue: 7 },
    ])
  })

  test("the status carries live threshold counts, and hears each change", async () => {
    const { send, market, relay } = await settled()
    expect(relay.status().thresholds).toEqual({ symbols: 2, warmingUp: 2 })
    const socket = await market()
    const LATER = Symbol.make("ASII")

    send(wireBatch([order(LATER, 1, 3, 10), order(LATER, 2, 4, 1)]))

    expect(
      socket.frames
        .flatMap((f) => (f.type === "status" ? [f.status.thresholds] : []))
        .at(-1)
    ).toEqual({ symbols: 3, warmingUp: 3 })
  })

  test("a page opened before the first order hears the counts begin", async () => {
    const { send, page } = await started()
    const socket = await page()

    send(wireBatch([order(BBCA, 1, 1, 10), order(BBCA, 2, 2, 1)]))

    expect(
      socket.frames
        .flatMap((f) => (f.type === "status" ? [f.status.thresholds] : []))
        .at(-1)
    ).toEqual({ symbols: 1, warmingUp: 1 })
  })

  test("a resume sends its rows oldest first across both kinds, so a dropped socket resumes from what arrived", async () => {
    const { sql, market } = await settled()
    const store = relayStore(sql)
    for (let n = 1; n <= 3; n++)
      store.upsertSweep({
        ...storedSweep({ firstNumber: 100 + n, at: n }),
        seq: 100 + n * 2,
      })
    store.upsertWall({ ...bbcaWall, day: TODAY, seq: 103 })
    const socket = await market(100)
    const seqs = socket.frames.flatMap((f) =>
      f.type === "sweep" || f.type === "wall" ? [f.seq] : []
    )
    expect(seqs).toEqual([102, 103, 104, 106])
  })

  test("a resume sends the newest 500 walls at most", async () => {
    const { sql, market } = await settled()
    const store = relayStore(sql)
    for (let n = 1; n <= 501; n++)
      store.upsertWall({
        ...bbcaWall,
        day: TODAY,
        firstOrderNumber: `${n}`,
        firstSeen: IsoDateTime.make(
          new Date(
            Date.parse(`${TODAY}T02:00:00.000Z`) + n * 1000
          ).toISOString()
        ),
      })
    const socket = await market(0)
    const sent = socket.frames.flatMap((f) =>
      f.type === "wall" ? [f.wall.firstOrderNumber] : []
    )
    expect(sent).toHaveLength(500)
    expect(sent).not.toContain("1")
    expect(sent).toContain("501")
  })

  test("the leaderboard's baseline has every symbol with sweeps, biggest first, and stays small", async () => {
    const { sql, relay } = await settled()
    const store = relayStore(sql)
    const symbols = "ABCDEFGHIJKL".split("").map((c) => Symbol.make(`${c}AAA`))
    symbols.forEach((symbol, i) =>
      store.upsertSweep(
        storedSweep({ firstNumber: 1, symbol, value: i + 1, at: i })
      )
    )
    const board = relay.today().leaderboard
    expect(board).toHaveLength(12)
    expect(board[0]?.symbol).toBe("LAAA")
    expect(board.at(-1)?.symbol).toBe("AAAA")
  })

  test("the leaderboard's baseline stays small on a first paint, at 850 symbols", async () => {
    const { sql, relay } = await settled()
    const store = relayStore(sql)
    const letter = (n: number) => String.fromCodePoint(65 + n)
    for (let n = 0; n < 850; n++)
      store.upsertSweep(
        storedSweep({
          firstNumber: 1,
          symbol: Symbol.make(
            `A${letter(Math.floor(n / 676))}${letter(Math.floor(n / 26) % 26)}${letter(n % 26)}`
          ),
          value: 1_234_567_890_123,
          at: n,
        })
      )
    const { leaderboard } = relay.today()
    expect(leaderboard).toHaveLength(850)
    expect(JSON.stringify(leaderboard).length).toBeLessThan(60_000)
  })

  test("earlier walks the day from a cursor, ties included, without repeats", async () => {
    const { sql, relay } = await settled()
    const store = relayStore(sql)
    for (let n = 1; n <= 501; n++)
      store.upsertSweep(storedSweep({ firstNumber: n, at: n }))
    // Three on one instant, which only the key tells apart.
    store.upsertSweep(storedSweep({ firstNumber: 1, at: 1, symbol: TLKM }))
    store.upsertSweep(storedSweep({ firstNumber: 2, at: 1, symbol: TLKM }))

    const seen = [...relay.today().sweeps]
    for (;;) {
      const tail = seen.at(-1)
      if (!tail) throw new Error("no rows")
      const next = relay.earlier(tail)
      if (!next.length) break
      seen.push(...next)
    }

    const keys = seen.map((s) => `${s.symbol}${s.firstNumber}`)
    expect(keys).toHaveLength(503)
    expect(new Set(keys).size).toBe(503)
    expect(keys.slice(-3)).toEqual(["BBCA1", "TLKM1", "TLKM2"])
  })

  test("earlier returns nothing for a day the relay has cleared", async () => {
    const { sql, relay } = await settled()
    const store = relayStore(sql)
    store.upsertSweep(storedSweep({ firstNumber: 1, at: 1 }))
    expect(
      relay.earlier({
        day: YESTERDAY,
        announcedAt: IsoDateTime.make(NOW),
        symbol: BBCA,
        firstNumber: 1,
      })
    ).toEqual([])
  })

  test("hears wall frames, resumes them at `since`, and today serves them newest first", async () => {
    const { sql, relay, market } = await settled()
    const store = relayStore(sql)
    const older = {
      ...bbcaWall,
      day: TODAY,
      firstOrderNumber: "1",
      firstSeen: IsoDateTime.make("2026-10-29T02:00:00.000Z"),
      seq: 3,
    }
    const newer = {
      ...older,
      firstOrderNumber: "2",
      firstSeen: IsoDateTime.make("2026-10-29T02:30:00.000Z"),
      seq: 4,
    }
    store.upsertWall(older)
    store.upsertWall(newer)

    const walls = (socket: FakeSocket) =>
      socket.frames.flatMap((f) =>
        f.type === "wall" ? [f.wall.firstOrderNumber] : []
      )
    expect(walls(await market(4))).toEqual(["2"])
    expect(relay.today().walls.map((w) => w.firstOrderNumber)).toEqual([
      "2",
      "1",
    ])
  })

  test("today on an empty relay is an empty day", async () => {
    const relay = new TradeRelay(objectState().ctx, ENV)
    expect(relay.today()).toMatchObject({
      day: null,
      sweeps: [],
      sweepsTotal: 0,
      leaderboard: [],
      thresholds: { symbols: 0, warmingUp: 0 },
    })
  })

  test("today counts the symbols with a threshold, and those warming up", async () => {
    const { relay } = await settled()
    expect(relay.today().thresholds).toEqual({ symbols: 2, warmingUp: 2 })
  })
})
