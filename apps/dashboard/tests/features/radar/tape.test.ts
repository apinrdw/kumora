import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type {
  RelayStatus,
  Sweep,
  TapeProvenance,
  Trade,
  TradeFrame,
  Wall,
} from "@/domain/trade"
import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import {
  createTapeStore,
  reduceTape,
  staleCopy,
  widenToLast,
} from "@/features/radar/tape"
import type { TapeEvent, TapeState } from "@/features/radar/tape"
import { silenceAction } from "@/features/radar/relay-store"
import { openingFrames } from "@/relay/opening-frames"
import { NO_QUOTE } from "@/relay/quote"
import { enrgSweep, noWhales } from "../../support/whales"

vi.mock("@/features/radar/query", () => ({
  relayTicket: () => Promise.resolve("ticket"),
}))

const live: TapeProvenance = {
  feed: "stockbit-running-trades",
  source: "extension",
  asOf: IsoDateTime.make("2026-10-29T03:00:01Z"),
  freshness: "live",
}

const trade = (
  tradeNumber: number,
  tradedAt = "2026-10-29T03:00:00Z"
): Trade => ({
  symbol: Symbol.make("BBCA"),
  price: 9000,
  volume: 100,
  value: 900_000,
  side: "buy",
  board: "RG",
  tradeNumber,
  tradedAt: IsoDateTime.make(tradedAt),
  receivedAt: IsoDateTime.make(tradedAt),
  change: 0,
})

const state = (over: Partial<TapeState> = {}): TapeState => ({
  trades: [trade(2), trade(1)],
  offBoard: [],
  seq: 10,
  provenance: live,
  quote: NO_QUOTE,
  quoteAsOf: live.asOf,
  day: "2026-10-29",
  status: null,
  socket: "open",
  reconnects: 0,
  ...noWhales,
  ...over,
})

const status = (over: Partial<RelayStatus> = {}): RelayStatus => ({
  source: "extension",
  freshness: "live",
  reason: null,
  upstreamEnabled: false,
  upstreamState: "disabled",
  credentialExpiresAt: null,
  ingests: 1,
  datafeed: true,
  clients: 1,
  lastTradeAt: live.asOf,
  seq: 10,
  day: "2026-10-29",
  symbols: 1,
  trades: 2,
  calendarOutOfDate: false,
  sweeps: 0,
  walls: 0,
  wallCoverage: [],
  thresholds: { symbols: 0, warmingUp: 0 },
  coverage: [],
  ...over,
})

const numbers = (s: TapeState) => s.trades.map((t) => t.tradeNumber)

describe("staleCopy", () => {
  const stale = { ...live, freshness: "stale" } as const

  test.each([
    ["closed", "Closed"],
    ["break", "Break"],
    ["no-source", "No source"],
    ["no-trades", "No trades"],
  ] as const)("%s reads %s", (reason, copy) => {
    expect(
      staleCopy(
        state({
          provenance: stale,
          status: status({ freshness: "stale", reason }),
        })
      )
    ).toBe(copy)
  })

  test("nothing beside a live pill, even before the status catches up", () => {
    expect(
      staleCopy(
        state({ status: status({ freshness: "stale", reason: "no-trades" }) })
      )
    ).toBeNull()
  })

  test("no reason yet, or a demotion the relay did not make, shows none", () => {
    expect(staleCopy(state({ provenance: stale }))).toBeNull()
    expect(staleCopy(state({ provenance: stale, status: status() }))).toBeNull()
  })
})

describe("reduceTape", () => {
  test("a trades frame puts its trades on top, newest first", () => {
    const next = reduceTape(state(), {
      type: "frame",
      frame: {
        type: "trades",
        seq: 11,
        provenance: live,
        trades: [trade(3), trade(4)],
      },
    })
    expect(numbers(next)).toEqual([4, 3, 2, 1])
    expect(next.seq).toBe(11)
  })

  test("a frame at or below the seq it has adds nothing", () => {
    const start = state()
    const next = reduceTape(start, {
      type: "frame",
      frame: { type: "trades", seq: 10, provenance: live, trades: [trade(3)] },
    })
    expect(next).toBe(start)
  })

  test("a resumed client keeps its tape through a reconnect, without repeats", () => {
    const closed = reduceTape(state(), { type: "socket", socket: "closed" })
    const resumed = reduceTape(closed, {
      type: "frame",
      frame: { type: "trades", seq: 12, provenance: live, trades: [trade(3)] },
    })
    expect(numbers(resumed)).toEqual([3, 2, 1])
  })

  test("the first trade of a new day drops the old day's", () => {
    const next = reduceTape(state(), {
      type: "frame",
      frame: {
        type: "trades",
        seq: 11,
        provenance: live,
        trades: [trade(1, "2026-10-30T02:00:00Z")],
      },
    })
    expect(next.trades).toHaveLength(1)
    expect(next.trades[0]?.tradedAt).toBe("2026-10-30T02:00:00Z")
  })

  test("a status frame promotes a quiet symbol, and only the relay can", () => {
    const stale = state({ provenance: { ...live, freshness: "stale" } })
    const next = reduceTape(stale, {
      type: "frame",
      frame: { type: "status", status: status() },
    })
    expect(next.provenance.freshness).toBe("live")
    expect(next.status?.ingests).toBe(1)
  })

  test("a status frame carries a demotion too", () => {
    const next = reduceTape(state(), {
      type: "frame",
      frame: {
        type: "status",
        status: status({
          source: "none",
          freshness: "stale",
          reason: "no-source",
        }),
      },
    })
    expect(next.provenance).toMatchObject({
      source: "none",
      freshness: "stale",
    })
  })

  test("a closed socket and silence demote live, and promote nothing", () => {
    expect(
      reduceTape(state(), { type: "socket", socket: "closed" }).provenance
        .freshness
    ).toBe("stale")
    expect(reduceTape(state(), { type: "silent" }).provenance.freshness).toBe(
      "stale"
    )
    const demo = state({ provenance: { ...live, freshness: "demo" } })
    expect(reduceTape(demo, { type: "silent" })).toBe(demo)
  })

  test("repeated silence does not wake the page", () => {
    const quiet = reduceTape(state(), { type: "silent" })
    expect(reduceTape(quiet, { type: "silent" })).toBe(quiet)
  })

  test("counts a reconnect only after a close", () => {
    const first = reduceTape(state({ socket: "idle" }), {
      type: "socket",
      socket: "connecting",
    })
    expect(first.reconnects).toBe(0)
    const closed = reduceTape(first, { type: "socket", socket: "closed" })
    expect(
      reduceTape(closed, { type: "socket", socket: "connecting" }).reconnects
    ).toBe(1)
  })
})

describe("the off-board list", () => {
  const ng = (tradeNumber: number, tradedAt?: string): Trade => ({
    ...trade(tradeNumber, tradedAt),
    board: "NG",
  })
  const tn = (tradeNumber: number): Trade => ({
    ...trade(tradeNumber),
    board: "TN",
  })
  const frame = (seq: number, trades: Array<Trade>): TapeEvent => ({
    type: "frame",
    frame: { type: "trades", seq, provenance: live, trades },
  })
  const offBoard = (s: TapeState) => s.offBoard.map((t) => t.tradeNumber)

  test("a trades frame puts its off-board trades on top, and leaves regular-board ones out", () => {
    const next = reduceTape(
      state({ offBoard: [ng(1)] }),
      frame(11, [tn(3), trade(4), ng(5)])
    )
    expect(offBoard(next)).toEqual([5, 3, 1])
    expect(numbers(next)).toEqual([5, 4, 3, 2, 1])
  })

  test("a trade number it holds adds no second row", () => {
    const held = state({ offBoard: [ng(3)] })
    const next = reduceTape(held, frame(11, [ng(3), ng(4), ng(4)]))
    expect(offBoard(next)).toEqual([4, 3])
  })

  test("holds the session past the newest 200 trades, up to 500", () => {
    const busy = Array.from({ length: 300 }, (_, i) => trade(i + 2))
    const next = reduceTape(
      state({ trades: [], offBoard: [ng(1)] }),
      frame(11, busy)
    )
    expect(next.trades).toHaveLength(200)
    expect(offBoard(next)).toEqual([1])

    const many = Array.from({ length: 501 }, (_, i) => ng(i + 1))
    const capped = reduceTape(state(), frame(11, many))
    expect(capped.offBoard).toHaveLength(500)
    expect(capped.offBoard[0]?.tradeNumber).toBe(501)
  })

  test("a new trading day clears it", () => {
    const held = state({ offBoard: [ng(7)] })
    const byTrade = reduceTape(
      held,
      frame(11, [trade(1, "2026-10-30T02:00:00Z")])
    )
    expect(byTrade.offBoard).toEqual([])
    const byStatus = reduceTape(held, {
      type: "frame",
      frame: { type: "status", status: status({ day: "2026-10-30" }) },
    })
    expect(byStatus.offBoard).toEqual([])
  })

  test("the same trade number on a new day is a new trade", () => {
    const held = state({ offBoard: [ng(1)] })
    const next = reduceTape(held, frame(11, [ng(1, "2026-10-30T02:00:00Z")]))
    expect(next.offBoard.map((t) => t.tradedAt)).toEqual([
      "2026-10-30T02:00:00Z",
    ])
  })
})

describe("the hero's quote", () => {
  const quoted = {
    ...NO_QUOTE,
    last: 5050,
    prev: 5275,
    high: 5325,
    low: 5000,
    volumeLot: 1000,
  }
  const asOf = IsoDateTime.make("2026-10-29T06:30:05Z")
  const quoteFrame = {
    type: "quote",
    symbol: Symbol.make("BBCA"),
    quote: quoted,
    provenance: {
      feed: "stockbit-liveprice",
      source: "extension",
      asOf,
      freshness: "live",
    },
  } as const
  const tradesFrame = (trades: ReadonlyArray<Trade>, seq = 11) =>
    ({ type: "trades", seq, provenance: live, trades }) as const

  test("a quote frame sets the figures and leaves the tape and its pill alone", () => {
    const before = state({ provenance: { ...live, freshness: "stale" } })
    const next = reduceTape(before, { type: "frame", frame: quoteFrame })
    expect(next.quote).toEqual(quoted)
    expect(next.quoteAsOf).toBe(asOf)
    expect(next.trades).toBe(before.trades)
    expect(next.provenance.freshness).toBe("stale")
  })

  test("an RG trade sets last, keeping liveprice's previous close", () => {
    const next = reduceTape(state({ quote: quoted }), {
      type: "frame",
      frame: tradesFrame([{ ...trade(3), price: 5075, change: 999 }]),
    })
    expect(next.quote.last).toBe(5075)
    expect(next.quote.prev).toBe(5275)
    expect(next.quoteAsOf).toBe(live.asOf)
  })

  test("an NG trade reaches the tape but not the quote", () => {
    const before = state({ quoteAsOf: asOf })
    const next = reduceTape(before, {
      type: "frame",
      frame: tradesFrame([{ ...trade(3), board: "NG", price: 7000 }]),
    })
    expect(next.quote).toBe(NO_QUOTE)
    expect(next.quoteAsOf).toBe(asOf)
    expect(next.trades[0]?.tradeNumber).toBe(3)
  })

  test("silence keeps the figures and their as-of under STALE", () => {
    const next = reduceTape(state({ quote: quoted, quoteAsOf: asOf }), {
      type: "silent",
    })
    expect(next.provenance.freshness).toBe("stale")
    expect(next.quote).toEqual(quoted)
    expect(next.quoteAsOf).toBe(asOf)
  })

  test("a new day's trade clears the figures before it applies", () => {
    const next = reduceTape(state({ quote: quoted }), {
      type: "frame",
      frame: tradesFrame([
        {
          ...trade(1, "2026-10-30T02:00:00Z"),
          price: 5100,
          change: 25,
        },
      ]),
    })
    expect(next.quote).toEqual({ ...NO_QUOTE, last: 5100, prev: 5075 })
    expect(next.trades).toHaveLength(1)
  })

  test("a quiet symbol hears the day clear from a status frame: dashes, and no as-of", () => {
    const next = reduceTape(state({ quote: quoted, quoteAsOf: asOf }), {
      type: "frame",
      frame: { type: "status", status: status({ day: "2026-10-30" }) },
    })
    expect(next.quote).toEqual(NO_QUOTE)
    expect(next.quoteAsOf).toBeNull()
    expect(next.trades).toEqual([])
    expect(next.day).toBe("2026-10-30")
  })

  test("a first day clears figures the page held before it knew one", () => {
    const next = reduceTape(
      state({
        day: null,
        quote: { ...NO_QUOTE, volumeLot: 500 },
      }),
      {
        type: "frame",
        frame: { type: "status", status: status({ day: "2026-10-29" }) },
      }
    )
    expect(next.quote).toEqual(NO_QUOTE)
    expect(next.quoteAsOf).toBeNull()
    expect(next.day).toBe("2026-10-29")
  })

  test("a status frame of the same day keeps the figures", () => {
    const next = reduceTape(state({ quote: quoted }), {
      type: "frame",
      frame: { type: "status", status: status() },
    })
    expect(next.quote).toEqual(quoted)
  })

  describe("a page reconnecting across a day rollover", () => {
    const yesterday = state({
      quote: { ...quoted, last: 4000 },
      quoteAsOf: asOf,
    })
    const rolled = {
      type: "status",
      status: status({ day: "2026-10-30" }),
    } as const
    const open = (missed: TradeFrame | null) =>
      openingFrames({
        status: rolled,
        missed,
        sweeps: [],
        walls: [],
        threshold: { type: "threshold", seq: 1, threshold: noWhales.threshold },
        quote: quoteFrame,
      }).reduce(
        (page, frame) => reduceTape(page, { type: "frame", frame }),
        yesterday
      )

    test("a quiet symbol keeps today's cached figures", () => {
      const page = open(null)
      expect(page.quote).toEqual(quoted)
      expect(page.quoteAsOf).toBe(asOf)
      expect(page.day).toBe("2026-10-30")
      expect(page.trades).toEqual([])
    })

    test("the cached figures have the last word over the missed trades", () => {
      const page = open(
        tradesFrame([{ ...trade(3, "2026-10-30T03:00:00Z"), price: 5100 }])
      )
      expect(page.quote).toEqual(quoted)
      expect(numbers(page)).toEqual([3])
    })
  })

  test("high and low widen to include the last price", () => {
    expect(widenToLast({ ...quoted, last: 5400 }).high).toBe(5400)
    expect(widenToLast({ ...quoted, last: 4900 }).low).toBe(4900)
    expect(widenToLast(quoted)).toMatchObject({ high: 5325, low: 5000 })
  })

  test("an unknown high or low stays unknown, and no last widens nothing", () => {
    const noRange = { ...NO_QUOTE, last: 5050 }
    expect(widenToLast(noRange)).toMatchObject({ high: null, low: null })
    expect(widenToLast({ ...quoted, last: null })).toMatchObject({
      high: 5325,
      low: 5000,
    })
  })
})

describe("silenceAction", () => {
  test("a socket heard within 30 s is left alone", () => {
    expect(silenceAction(30_000, true)).toBe("none")
  })

  test("a silent socket is reconnected, whose opening status can promote again", () => {
    expect(silenceAction(30_001, true)).toBe("reconnect")
  })

  test("with no socket to replace, silence only demotes", () => {
    expect(silenceAction(30_001, false)).toBe("demote")
  })
})

describe("createTapeStore", () => {
  class FakeSocket {
    static readonly OPEN = 1
    static made: Array<FakeSocket> = []
    readyState = FakeSocket.OPEN
    closed = false
    onopen: (() => void) | null = null
    onmessage: ((e: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    constructor(readonly url: string) {
      FakeSocket.made.push(this)
    }
    send() {}
    close() {
      this.closed = true
    }
  }

  beforeEach(() => {
    FakeSocket.made = []
    vi.useFakeTimers()
    vi.stubGlobal("WebSocket", FakeSocket)
    vi.stubGlobal("location", { protocol: "https:", host: "kumora.test" })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test("the hero dates its first paint and a reconnect from the quote, not a newer NG trade", async () => {
    const quoteAsOf = IsoDateTime.make("2026-10-29T02:59:00Z")
    const backfill = {
      symbol: Symbol.make("BBCA"),
      seq: 10,
      day: "2026-10-29",
      trades: [{ ...trade(2), board: "NG" }],
      offBoard: [],
      quote: { ...NO_QUOTE, last: 9000 },
      quoteAsOf,
      coverage: [],
      ...noWhales,
      provenance: live,
    }
    const store = createTapeStore(Symbol.make("BBCA"), backfill)
    expect(store.getServerSnapshot().quoteAsOf).toBe(quoteAsOf)
    expect(store.getServerSnapshot().provenance.asOf).toBe(live.asOf)

    const stop = store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    FakeSocket.made[0]?.onclose?.()
    expect(store.getSnapshot().socket).toBe("closed")
    expect(store.getSnapshot().quoteAsOf).toBe(quoteAsOf)
    stop()
  })

  test("a day that advances between the backfill and the socket clears a symbol's cached totals", async () => {
    const backfill = {
      symbol: Symbol.make("BBCA"),
      seq: 10,
      day: "2026-10-29",
      trades: [],
      offBoard: [],
      quote: { ...NO_QUOTE, last: 9000, volumeLot: 500 },
      quoteAsOf: live.asOf,
      coverage: [],
      ...noWhales,
      provenance: live,
    }
    const store = createTapeStore(Symbol.make("BBCA"), backfill)
    const stop = store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeSocket.made[0]
    socket?.onopen?.()
    socket?.onmessage?.({
      data: JSON.stringify({
        type: "status",
        status: status({ day: "2026-10-30" }),
      }),
    })

    const { quote, quoteAsOf, day } = store.getSnapshot()
    expect(day).toBe("2026-10-30")
    expect(quote).toEqual(NO_QUOTE)
    expect(quoteAsOf).toBeNull()
    stop()
  })

  test("a quiet symbol keeps its quote through a status frame of the backfill's day", async () => {
    const quote = { ...NO_QUOTE, last: 9000, volumeLot: 500 }
    const store = createTapeStore(Symbol.make("BBCA"), {
      symbol: Symbol.make("BBCA"),
      seq: 10,
      day: "2026-10-29",
      trades: [],
      offBoard: [],
      quote,
      quoteAsOf: live.asOf,
      coverage: [],
      ...noWhales,
      provenance: live,
    })
    const stop = store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeSocket.made[0]
    socket?.onopen?.()
    socket?.onmessage?.({
      data: JSON.stringify({
        type: "status",
        status: status({ day: "2026-10-29" }),
      }),
    })

    expect(store.getSnapshot()).toMatchObject({
      day: "2026-10-29",
      quote,
      quoteAsOf: live.asOf,
    })
    stop()
  })

  test("a silent socket on a quiet symbol is replaced, and the new one's status promotes the page", async () => {
    const store = createTapeStore(Symbol.make("BBCA"), {
      symbol: Symbol.make("BBCA"),
      seq: 10,
      day: "2026-10-29",
      trades: [],
      offBoard: [],
      quote: NO_QUOTE,
      quoteAsOf: null,
      coverage: [],
      ...noWhales,
      provenance: live,
    })
    const stop = store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(0)
    const first = FakeSocket.made[0]
    first?.onopen?.()
    first?.onmessage?.({
      data: JSON.stringify({ type: "status", status: status() }),
    })
    expect(store.getSnapshot().provenance.freshness).toBe("live")

    await vi.advanceTimersByTimeAsync(45_000)
    expect(store.getSnapshot().provenance.freshness).toBe("stale")
    expect(first?.closed).toBe(true)

    await vi.advanceTimersByTimeAsync(1000)
    const second = FakeSocket.made[1]
    expect(second).toBeDefined()
    second?.onopen?.()
    second?.onmessage?.({
      data: JSON.stringify({ type: "status", status: status() }),
    })
    expect(store.getSnapshot().provenance.freshness).toBe("live")
    stop()
  })
})

describe("sweeps on the page", () => {
  const sweepFrame = (over: Partial<Sweep> = {}): TradeFrame => ({
    type: "sweep",
    seq: 99,
    provenance: { ...live, asOf: IsoDateTime.make("2026-10-29T06:42:36Z") },
    sweep: { ...enrgSweep, ...over },
    threshold: { ...noWhales.threshold, threshold: 696, ordersToday: 32 },
  })
  const hear = (page: TapeState, frame: TradeFrame) =>
    reduceTape(page, { type: "frame", frame })

  test("announced, grown, then closed is one row in its last state", () => {
    const page = [
      sweepFrame({ open: true, closedBy: null, lots: 700, freq: 3 }),
      sweepFrame({ open: true, closedBy: null, lots: 9000, freq: 40 }),
      sweepFrame(),
    ].reduce(hear, state())

    expect(page.sweeps).toEqual([enrgSweep])
    expect(page.threshold.threshold).toBe(696)
  })

  test("a repeated resume adds nothing", () => {
    const once = hear(state(), sweepFrame())
    expect(hear(once, sweepFrame()).sweeps).toHaveLength(1)
  })

  test("newest announced comes first", () => {
    const later = IsoDateTime.make("2026-10-29T07:00:00.000Z")
    const page = [
      sweepFrame({ firstNumber: 1 }),
      sweepFrame({ firstNumber: 2, announcedAt: later }),
    ].reduce(hear, state())
    expect(page.sweeps.map((s) => s.firstNumber)).toEqual([2, 1])
  })

  test("a sweep frame leaves the resume point of trades alone", () => {
    const page = hear(state({ seq: 10 }), sweepFrame())
    expect(page.seq).toBe(10)
    const next = hear(page, {
      type: "trades",
      seq: 11,
      provenance: live,
      trades: [trade(3)],
    })
    expect(numbers(next)).toEqual([3, 2, 1])
  })

  test("trades frames carry no flag and make no row", () => {
    const page = hear(state(), {
      type: "trades",
      seq: 11,
      provenance: live,
      trades: [trade(3)],
    })
    expect(page.sweeps).toEqual([])
    expect(Object.keys(page.trades[0] ?? {})).not.toContain("sweep")
  })

  test("an old row resumed does not move the as-of back", () => {
    const held = IsoDateTime.make("2026-10-29T07:30:00Z")
    const page = hear(
      state({ provenance: { ...live, asOf: held } }),
      sweepFrame()
    )
    expect(page.provenance.asOf).toBe(held)
  })

  test("a threshold frame replaces the chip's state", () => {
    const threshold = {
      ...noWhales.threshold,
      threshold: 12,
      prior: "own",
    } as const
    const page = hear(state(), { type: "threshold", seq: 1, threshold })
    expect(page.threshold).toEqual(threshold)
  })

  test("a new day clears the rows and the threshold", () => {
    const page = hear(state(), sweepFrame())
    const next = hear(page, {
      type: "status",
      status: status({ day: "2026-10-30" }),
    })
    expect(next.sweeps).toEqual([])
    expect(next.threshold).toMatchObject({ threshold: null, ordersToday: 0 })
  })

  test("a wall upserts by its key", () => {
    const wall: Wall = {
      day: "2026-10-29",
      symbol: Symbol.make("BBCA"),
      side: "offer",
      price: 5050,
      firstOrderNumber: "202610290002329192",
      memberOrderNumbers: ["202610290002329192"],
      hitsSeen: 2,
      lotsMatched: 800,
      threshold: 696,
      warmingUp: true,
      prior: "own",
      firstSeen: IsoDateTime.make("2026-10-29T06:31:19Z"),
      lastSeen: IsoDateTime.make("2026-10-29T06:31:20Z"),
      closedAt: null,
      closedBy: null,
      seq: 3,
    }
    const frame = (hitsSeen: number): TradeFrame => ({
      type: "wall",
      seq: 3,
      provenance: { ...noWhales.liveprice, freshness: "live" },
      wall: { ...wall, hitsSeen },
      threshold: noWhales.threshold,
    })
    const page = [frame(2), frame(95)].reduce(hear, state())
    expect(page.walls.map((w) => w.hitsSeen)).toEqual([95])
    expect(page.liveprice.freshness).toBe("live")
  })

  test("the two pills go stale apart, on what the status says of each", () => {
    const receiving = status({
      wallCoverage: [{ symbol: Symbol.make("BBCA"), receiving: true }],
    })
    const heard = [{ type: "status", status: receiving } as const].reduce(
      hear,
      state()
    )
    expect(heard.provenance.freshness).toBe("live")
    expect(heard.liveprice).toMatchObject({
      freshness: "live",
      source: "extension",
    })

    const framesStopped = hear(heard, {
      type: "status",
      status: status({
        wallCoverage: [{ symbol: Symbol.make("BBCA"), receiving: false }],
      }),
    })
    expect(framesStopped.provenance.freshness).toBe("live")
    expect(framesStopped.liveprice.freshness).toBe("stale")

    const tapeStopped = hear(heard, {
      type: "status",
      status: { ...receiving, freshness: "stale", reason: "no-trades" },
    })
    expect(tapeStopped.provenance.freshness).toBe("stale")
    expect(tapeStopped.liveprice.freshness).toBe("live")
  })

  test("any frame across the wall coverage keeps the pill live, on a quiet symbol too", () => {
    const page = hear(state(), {
      type: "status",
      status: status({
        wallCoverage: [
          { symbol: Symbol.make("BBCA"), receiving: false },
          { symbol: Symbol.make("TLKM"), receiving: true },
        ],
      }),
    })
    expect(page.liveprice.freshness).toBe("live")
  })

  test("with no source the walls' feed is stale, whatever it last heard", () => {
    const page = hear(state(), {
      type: "status",
      status: status({
        source: "none",
        wallCoverage: [{ symbol: Symbol.make("BBCA"), receiving: true }],
      }),
    })
    expect(page.liveprice.freshness).toBe("stale")
  })

  test("the coverage follows the status: covered or not", () => {
    const covered = status({
      wallCoverage: [{ symbol: state().threshold.symbol, receiving: false }],
    })
    const page = hear(state({ wallCoverage: false }), {
      type: "status",
      status: covered,
    })
    expect(page.wallCoverage).toBe(true)
    const off = hear(page, {
      type: "status",
      status: status({ wallCoverage: [] }),
    })
    expect(off.wallCoverage).toBe(false)
  })

  test("silence demotes both feeds, each on its own", () => {
    const page = reduceTape(
      state({ liveprice: { ...noWhales.liveprice, freshness: "live" } }),
      { type: "silent" }
    )
    expect(page.provenance.freshness).toBe("stale")
    expect(page.liveprice.freshness).toBe("stale")
  })
})
