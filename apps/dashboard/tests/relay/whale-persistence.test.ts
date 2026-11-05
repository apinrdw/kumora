import { describe, expect, test } from "vitest"

import { SYMBOL_PATTERN } from "@/domain/symbol-guard"
import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { Sweep, Trade, TradeSide } from "@/domain/trade"
import { relayStore } from "@/relay/store"
import type { RelayStore } from "@/relay/store"
import { dedupe, groupBySymbol } from "@/relay/tape"
import { tradingDay } from "@/relay/trading-day"
import { closeIdle, createWhales, feedTrades, sketchOf } from "@/relay/whale"
import type { WhaleState } from "@/relay/whale"
import {
  endWhaleSession,
  flushWhales,
  rebuildWhales,
} from "@/relay/whale-persistence"

import { sqlStorage } from "../support/sql-storage"
import { readCapture, readWhaleFixture, SIDE } from "../support/whale-capture"

const BBCA = Symbol.make("BBCA")
const TLKM = Symbol.make("TLKM")
const ENDED = "2026-10-28"
const BEFORE = "2026-10-27"
const TODAY = "2026-10-29"
const NEXT = "2026-10-30"

const capture = readCapture()
const expected = readWhaleFixture<{
  cut: string
  priors: Record<string, ReadonlyArray<number>>
  sweeps: ReadonlyArray<{
    symbol: string
    firstNumber: number
    side: TradeSide
  }>
}>("expected.json")

const batches = capture.batches
  .filter((batch) => batch.t >= expected.cut)
  .map((batch) => ({
    receivedAt: IsoDateTime.make(batch.t),
    trades: batch.trades
      .filter((row) => SYMBOL_PATTERN.test(row[0]))
      .map((row): Trade => ({
        symbol: Symbol.make(row[0]),
        price: row[1],
        volume: row[2],
        side: SIDE[row[3]],
        tradedAt: IsoDateTime.make(row[4]),
        tradeNumber: row[5],
        board: row[6],
        value: row[7],
        receivedAt: IsoDateTime.make(batch.t),
        change: 0,
      })),
  }))

/** The session before the capture's, as `expected.json` holds it. */
const storePriors = (store: RelayStore, day: string) => {
  const { "*": market = [], ...own } = expected.priors
  for (const [symbol, lots] of Object.entries(own))
    store.upsertSketch(Symbol.make(symbol), day, sketchOf(lots))
  store.upsertSketch("*", day, sketchOf(market))
}

/** What the relay's batch path does with the object's state, without its sockets. */
const session = () => {
  const store = relayStore(sqlStorage())
  store.create()
  const captureDay = tradingDay(batches[0]?.trades[0]?.tradedAt ?? "")
  const previous = "2026-10-28"
  storePriors(store, previous)
  const last = new Map<Symbol, number>()
  const lastSeq = new Map<Symbol, number>()
  const state = {
    store,
    captureDay,
    whales: rebuildWhales(store, captureDay, [], 0),
    seq: 0,
    replayFrom: 0,
    /** Runs batches from `from` up to `to`. */
    run(from: number, to: number) {
      for (const { receivedAt, trades } of batches.slice(from, to)) {
        const fresh = dedupe(last, trades)
        if (!fresh.length) continue
        const seq = ++state.seq
        for (const [symbol, slice] of groupBySymbol(fresh)) {
          store.appendBatch(symbol, seq, captureDay, receivedAt, slice, null)
          lastSeq.set(symbol, seq)
        }
        for (const { sweeps } of [
          feedTrades(state.whales, fresh, seq),
          closeIdle(state.whales, Date.parse(receivedAt), seq),
        ])
          for (const sweep of sweeps) store.upsertSweep(sweep)
      }
    },
    flush() {
      state.replayFrom = flushWhales(store, state.whales, captureDay, state.seq)
    },
    /** What `load()` does: from the rows, and only the tape's rows it must. */
    rebuild() {
      const symbols = [...lastSeq]
        .filter(([, seq]) => seq >= state.replayFrom)
        .map(([symbol]) => symbol)
      state.whales = rebuildWhales(store, captureDay, symbols, state.replayFrom)
    },
    sweeps() {
      return [...lastSeq.keys()]
        .flatMap((symbol) => store.sweepsOf(captureDay, symbol))
        .map(comparable)
        .sort((a, b) => a.key.localeCompare(b.key))
    },
  }
  return state
}

const comparable = (s: Sweep) => ({
  key: `${s.symbol}:${s.firstNumber}:${s.side}`,
  lots: s.lots,
  freq: s.freq,
  threshold: s.threshold,
  warmingUp: s.warmingUp,
  prior: s.prior,
  announcedAt: s.announcedAt,
  open: s.open,
})

const sketchList = (whales: WhaleState) =>
  [...whales.sketches]
    .map(([symbol, { n, lastNumber, buckets }]) => ({
      symbol,
      n,
      lastNumber,
      buckets: [...buckets],
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol))

const uninterrupted = () => {
  const run = session()
  run.run(0, batches.length)
  return run
}

/** The first batch at or after `from` that leaves an order open. */
const cutWithOpenOrder = (from: number) => {
  const probe = session()
  probe.run(0, from)
  for (let i = from; i < batches.length; i++) {
    if (probe.whales.open.size > 0) return i
    probe.run(i, i + 1)
  }
  throw new Error("no order open")
}

describe("flush and rebuild over the capture", () => {
  test("half the capture, a flush with an order open, a rebuild, and the rest match an uninterrupted run", () => {
    const whole = uninterrupted()
    const cut = cutWithOpenOrder(Math.floor(batches.length / 2))
    const run = session()

    run.run(0, cut)
    expect(run.whales.open.size).toBeGreaterThan(0)
    run.flush()
    run.rebuild()
    expect(run.whales.open.size).toBeGreaterThan(0)
    run.run(cut, batches.length)

    expect(run.sweeps()).toEqual(whole.sweeps())
    expect(sketchList(run.whales)).toEqual(sketchList(whole.whales))
    expect(run.sweeps().map((s) => s.key)).toEqual(
      expected.sweeps
        .map((s) => `${s.symbol}:${s.firstNumber}:${s.side}`)
        .sort((a, b) => a.localeCompare(b))
    )
  })

  test("a rebuild with batches after the flush lands on the same rows", () => {
    const whole = uninterrupted()
    const cut = cutWithOpenOrder(Math.floor(batches.length / 3))
    const run = session()

    run.run(0, cut)
    run.flush()
    // A crash 40 batches on: those are on the tape, and not in the sketches.
    run.run(cut, cut + 40)
    const rows = run.sweeps().length
    run.rebuild()
    expect(run.sweeps().map((s) => s.key)).toHaveLength(rows)
    run.run(cut + 40, batches.length)

    expect(run.sweeps()).toEqual(whole.sweeps())
    expect(sketchList(run.whales)).toEqual(sketchList(whole.whales))
  })

  test("many restarts in a session change nothing", () => {
    const whole = uninterrupted()
    const run = session()

    for (let i = 0; i < batches.length; i += 97) {
      run.run(i, i + 97)
      run.flush()
      run.rebuild()
    }

    expect(run.sweeps()).toEqual(whole.sweeps())
    expect(sketchList(run.whales)).toEqual(sketchList(whole.whales))
  })

  test("a rebuild before any flush reads the whole tape per symbol and agrees", () => {
    const whole = uninterrupted()
    const run = session()

    run.run(0, batches.length)
    run.rebuild()

    expect(run.sweeps()).toEqual(whole.sweeps())
    expect(sketchList(run.whales)).toEqual(sketchList(whole.whales))
  })
})

/** Closes one order of `lots` lots on `symbol`, as trade number `number`. */
const closedOrder = (
  whales: WhaleState,
  symbol: Symbol,
  number: number,
  lots: number
) => {
  const at = IsoDateTime.make("2026-10-28T03:00:00.000Z")
  feedTrades(
    whales,
    [
      {
        symbol,
        price: 100,
        volume: lots * 100,
        value: lots * 10_000,
        side: "buy",
        board: "RG",
        tradedAt: at,
        receivedAt: at,
        tradeNumber: number,
        change: 0,
      },
    ],
    number
  )
  closeIdle(whales, Date.parse(at) + 1000, number)
}

const sketchDays = (sql: SqlStorage) =>
  sql
    .exec<{ day: string; symbol: string }>(
      "SELECT day, symbol FROM sketches ORDER BY day, symbol"
    )
    .toArray()
    .map(({ day, symbol }) => `${day} ${symbol}`)

describe("flushing", () => {
  const stored = () => {
    const sql = sqlStorage()
    const store = relayStore(sql)
    store.create()
    return { sql, store }
  }

  test("writes the dirty symbols and the market's sum, then nothing until one changes", () => {
    const { sql, store } = stored()
    const whales = createWhales()
    closedOrder(whales, BBCA, 1, 10)
    closedOrder(whales, TLKM, 2, 20)

    flushWhales(store, whales, TODAY, 2)

    expect(sketchDays(sql)).toEqual([
      `${TODAY} *`,
      `${TODAY} BBCA`,
      `${TODAY} TLKM`,
    ])
    const { own, market } = store.sessionSketches(TODAY)
    expect(market?.n).toBe(2)
    expect(own.get(BBCA)).toEqual(whales.sketches.get(BBCA))

    expect(whales.dirty.size).toBe(0)
    sql.exec("DELETE FROM sketches")
    flushWhales(store, whales, TODAY, 2)
    expect(sketchDays(sql)).toEqual([])
  })

  test("whaleReplayFrom is the lowest first seq among open orders", () => {
    const { store } = stored()
    const whales = createWhales()
    const at = IsoDateTime.make("2026-10-28T03:00:00.000Z")
    const open = (symbol: Symbol, number: number, seq: number) =>
      feedTrades(
        whales,
        [
          {
            symbol,
            price: 100,
            volume: 100,
            value: 10_000,
            side: "buy",
            board: "RG",
            tradedAt: at,
            receivedAt: at,
            tradeNumber: number,
            change: 0,
          },
        ],
        seq
      )
    open(BBCA, 1, 7)
    open(TLKM, 2, 5)

    expect(flushWhales(store, whales, TODAY, 9)).toBe(5)
  })

  test("whaleReplayFrom is the next seq when no order is open", () => {
    const { store } = stored()
    expect(flushWhales(store, createWhales(), TODAY, 9)).toBe(10)
  })
})

describe("the rebuild's reads", () => {
  test("reads the tape only from `from`, and only for the symbols named", () => {
    const store = relayStore(sqlStorage())
    store.create()
    const at = IsoDateTime.make("2026-10-29T03:00:00.000Z")
    const row = (symbol: Symbol, seq: number, tradeNumber: number) =>
      store.appendBatch(
        symbol,
        seq,
        TODAY,
        at,
        [
          {
            symbol,
            price: 100,
            volume: 100,
            value: 10_000,
            side: "buy",
            board: "RG",
            tradedAt: at,
            receivedAt: at,
            tradeNumber,
            change: 0,
          },
        ],
        null
      )
    // Quiet since the morning, then an order on another symbol.
    row(TLKM, 1, 1)
    row(BBCA, 1, 2)
    row(BBCA, 5, 3)

    const whales = rebuildWhales(store, TODAY, [BBCA], 5)

    expect(whales.open.get(BBCA)?.firstNumber).toBe(3)
    expect(whales.open.has(TLKM)).toBe(false)
  })
})

describe("the end of a session", () => {
  const ended = () => {
    const sql = sqlStorage()
    const store = relayStore(sql)
    store.create()
    return { sql, store }
  }

  test("closes open orders and flushes them into the new session's prior", () => {
    const { store } = ended()
    const whales = createWhales()
    closedOrder(whales, BBCA, 1, 10)
    const at = IsoDateTime.make("2026-10-28T03:00:01.000Z")
    feedTrades(
      whales,
      [
        {
          symbol: TLKM,
          price: 100,
          volume: 2000,
          value: 200_000,
          side: "buy",
          board: "RG",
          tradedAt: at,
          receivedAt: at,
          tradeNumber: 2,
          change: 0,
        },
      ],
      2
    )
    expect(whales.open.size).toBe(1)

    const next = endWhaleSession(store, whales, ENDED, NEXT, 2)

    expect(whales.open.size).toBe(0)
    expect(next.priors.own.get(TLKM)?.n).toBe(1)
    expect(next.priors.own.get(BBCA)?.n).toBe(1)
    expect(next.priors.market?.n).toBe(2)
    expect(next.sketches.size).toBe(0)
  })

  test("the ended session's sketches survive, and the one before does not", () => {
    const { sql, store } = ended()
    store.upsertSketch(BBCA, BEFORE, sketchOf([1]))
    store.upsertSketch("*", BEFORE, sketchOf([1]))
    const whales = createWhales()
    closedOrder(whales, BBCA, 1, 10)

    endWhaleSession(store, whales, ENDED, NEXT, 1)

    expect(sketchDays(sql)).toEqual([`${ENDED} *`, `${ENDED} BBCA`])
  })

  test("a session that ended with no orders leaves the last one with rows as the prior", () => {
    const { sql, store } = ended()
    store.upsertSketch(BBCA, BEFORE, sketchOf([1]))
    store.upsertSketch("*", BEFORE, sketchOf([1]))

    const next = endWhaleSession(store, createWhales(), ENDED, NEXT, 1)

    expect(next.priors.own.get(BBCA)?.n).toBe(1)
    expect(sketchDays(sql)).toEqual([`${BEFORE} *`, `${BEFORE} BBCA`])
  })
})
