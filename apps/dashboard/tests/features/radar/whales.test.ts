import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type {
  RelayStatus,
  Sweep,
  SweepCursor,
  TapeProvenance,
  TradeFrame,
  Wall,
  WhalesToday,
} from "@/domain/trade"
import { EMPTY_WHALES_TODAY } from "@/features/radar/data"
import {
  addEarlier,
  createWhalesStore,
  hasEarlier,
  mostSwept,
  reduceWhales,
  resetToToday,
  whalesState,
} from "@/features/radar/whales"
import type { WhalesState } from "@/features/radar/whales"
import { bbcaWall, enrgSweep } from "../../support/whales"

const earlierSweeps = vi.hoisted(() =>
  vi.fn<(input: { data: SweepCursor }) => Promise<ReadonlyArray<Sweep>>>()
)
const whalesToday = vi.hoisted(() => vi.fn<() => Promise<WhalesToday>>())

vi.mock("@/features/radar/query", () => ({
  relayTicket: () => Promise.resolve("ticket"),
  earlierSweeps,
  whalesToday,
}))

const DAY = "2026-10-29"
const ENRG = enrgSweep.symbol
const BBCA = Symbol.make("BBCA")

const live: TapeProvenance = {
  feed: "stockbit-running-trades",
  source: "extension",
  asOf: IsoDateTime.make("2026-10-29T06:00:00.000Z"),
  freshness: "live",
}

const sweep = (firstNumber: number, patch: Partial<Sweep> = {}): Sweep => ({
  ...enrgSweep,
  firstNumber,
  announcedAt: IsoDateTime.make(
    new Date(Date.parse(`${DAY}T06:00:00.000Z`) + firstNumber).toISOString()
  ),
  seq: 10,
  ...patch,
})

const sweepFrame = (row: Sweep): TradeFrame => ({
  type: "sweep",
  seq: row.seq,
  provenance: live,
  sweep: row,
  threshold: {
    symbol: row.symbol,
    threshold: 10,
    warmingUp: true,
    prior: "none",
    ordersToday: 1,
    asOf: null,
  },
})

const sweepThreshold = {
  symbol: ENRG,
  threshold: 10,
  warmingUp: true,
  prior: "none",
  ordersToday: 1,
  asOf: null,
} satisfies Extract<TradeFrame, { type: "sweep" }>["threshold"]

const status = (patch: Partial<RelayStatus> = {}): TradeFrame => ({
  type: "status",
  status: {
    source: "extension",
    freshness: "live",
    reason: null,
    upstreamEnabled: false,
    upstreamState: "disabled",
    credentialExpiresAt: null,
    ingests: 1,
    datafeed: true,
    clients: 1,
    lastTradeAt: null,
    seq: 10,
    day: DAY,
    symbols: 1,
    trades: 1,
    calendarOutOfDate: false,
    sweeps: 0,
    walls: 0,
    wallCoverage: [],
    thresholds: { symbols: 0, warmingUp: 0 },
    coverage: [],
    ...patch,
  },
})

/** A first paint at seq 10 whose totals say ENRG has 500 of buy value. */
const painted = (patch: Partial<WhalesToday> = {}): WhalesState =>
  whalesState({
    ...EMPTY_WHALES_TODAY,
    seq: 10,
    day: DAY,
    sweeps: [sweep(1, { value: 200 })],
    sweepsTotal: 3,
    leaderboard: [{ symbol: ENRG, buyValue: 500, sellValue: 0 }],
    provenance: live,
    ...patch,
  })

const frames = (state: WhalesState, ...list: ReadonlyArray<TradeFrame>) =>
  list.reduce((s, frame) => reduceWhales(s, { type: "frame", frame }), state)

const buyOf = (state: WhalesState, symbol: Symbol) =>
  state.leaderboard.find((e) => e.symbol === symbol)?.buyValue

describe("the leaderboard", () => {
  test("a growing sweep adds only its change, and a repeat adds nothing", () => {
    const grown = sweep(1, { value: 260, seq: 11 })
    const state = frames(painted(), sweepFrame(grown), sweepFrame(grown))
    expect(buyOf(state, ENRG)).toBe(560)
  })

  test("a new sweep adds its whole value, then only what it grows by", () => {
    const state = frames(
      painted(),
      sweepFrame(sweep(2, { value: 100, seq: 11 })),
      sweepFrame(sweep(2, { value: 130, seq: 12 }))
    )
    expect(buyOf(state, ENRG)).toBe(630)
  })

  test("a symbol painted eleventh overtakes the top ten with its baseline", () => {
    const tens = "ABCDEFGHIJ".split("").map((c) => ({
      symbol: Symbol.make(`${c}AAA`),
      buyValue: 1000,
      sellValue: 0,
    }))
    const state = frames(
      painted({
        leaderboard: [...tens, { symbol: BBCA, buyValue: 999, sellValue: 0 }],
      }),
      sweepFrame(sweep(2, { symbol: BBCA, value: 100, seq: 11 }))
    )
    expect(mostSwept(state)).toHaveLength(10)
    expect(mostSwept(state)[0]).toEqual({
      symbol: BBCA,
      buyValue: 1099,
      sellValue: 0,
    })
  })

  test("a row at or below the paint's seq is already in its totals", () => {
    const state = frames(
      painted(),
      sweepFrame(sweep(2, { value: 99, seq: 10 }))
    )
    expect(buyOf(state, ENRG)).toBe(500)
  })

  test("a sell goes on the sell side, for a symbol the paint did not have", () => {
    const state = frames(
      painted(),
      sweepFrame(sweep(2, { symbol: BBCA, side: "sell", value: 70, seq: 11 }))
    )
    expect(state.leaderboard.find((e) => e.symbol === BBCA)).toEqual({
      symbol: BBCA,
      buyValue: 0,
      sellValue: 70,
    })
  })

  test("rows loaded from earlier are in the totals, and their growth is not new", () => {
    const old = sweep(0, { value: 40 })
    const state = addEarlier(painted(), [old])
    expect(buyOf(state, ENRG)).toBe(500)
    const grown = frames(state, sweepFrame({ ...old, value: 45, seq: 11 }))
    expect(buyOf(grown, ENRG)).toBe(505)
  })

  describe("a frame for a painted row past the loaded page", () => {
    const unloaded = sweep(0, { value: 40, seq: 11 })

    test("adds nothing to the leaderboard or the count", () => {
      const state = frames(
        painted(),
        sweepFrame(unloaded),
        sweepFrame({ ...unloaded, value: 45, seq: 12 })
      )
      expect(buyOf(state, ENRG)).toBe(500)
      expect(state.sweepsTotal).toBe(3)
      expect(state.seq).toBe(12)
    })

    test("leaves the tail where the next earlier page starts", () => {
      const state = frames(painted(), sweepFrame(unloaded))
      expect(state.sweeps.map((s) => s.firstNumber)).toEqual([1])
    })

    test("a whole-day page has no such row, so a new row tied with its tail counts", () => {
      const tail = sweep(1, { value: 200 })
      const tied = sweep(2, {
        symbol: Symbol.make("ZZZZ"),
        announcedAt: tail.announcedAt,
        value: 70,
        seq: 11,
      })
      const state = frames(painted({ sweepsTotal: 1 }), sweepFrame(tied))
      expect(state.sweepsTotal).toBe(2)
      expect(state.sweeps.map((s) => s.symbol)).toEqual([ENRG, tied.symbol])
      expect(buyOf(state, tied.symbol)).toBe(70)
    })
  })

  test("mostSwept is the top 10 by value, largest first", () => {
    const board = "ABCDEFGHIJKL".split("").map((c, i) => ({
      symbol: Symbol.make(`${c}AAA`),
      buyValue: i,
      sellValue: i,
    }))
    const top = mostSwept({ ...painted(), leaderboard: board })
    expect(top).toHaveLength(10)
    expect(top[0]?.symbol).toBe("LAAA")
    expect(top.at(-1)?.symbol).toBe("CAAA")
  })
})

describe("a row of a day before the state's", () => {
  const NEXT_DAY = "2026-10-30"
  const onNextDay = () =>
    painted({
      day: NEXT_DAY,
      sweeps: [sweep(1, { day: NEXT_DAY, value: 200 })],
      walls: [{ ...bbcaWall, day: NEXT_DAY }],
    })

  test("a sweep is not held, counted, or on the leaderboard", () => {
    const state = onNextDay()
    const next = frames(
      state,
      sweepFrame(sweep(2, { value: 999, seq: 20, day: DAY }))
    )
    expect(next.day).toBe(NEXT_DAY)
    expect(next.sweeps).toEqual(state.sweeps)
    expect(next.sweepsTotal).toBe(state.sweepsTotal)
    expect(next.leaderboard).toEqual(state.leaderboard)
  })

  test("a wall is not held", () => {
    const state = onNextDay()
    const next = frames(state, {
      type: "wall",
      seq: 20,
      provenance: { ...live, feed: "stockbit-liveprice" },
      wall: { ...bbcaWall, day: DAY, seq: 20 },
      threshold: sweepThreshold,
    })
    expect(next.day).toBe(NEXT_DAY)
    expect(next.walls).toEqual(state.walls)
  })
})

describe("a status against the counters held", () => {
  test("one of a day before the state's replaces nothing, whatever its seq", () => {
    const state = frames(
      painted(),
      sweepFrame(sweep(1, { day: "2026-10-30", seq: 12 })),
      status({
        seq: 12,
        sweeps: 99,
        thresholds: { symbols: 42, warmingUp: 7 },
      })
    )
    expect(state.sweepsTotal).toBe(1)
    expect(state.countedSeq).toBe(10)
    expect(state.thresholds).toEqual({ symbols: 0, warmingUp: 0 })
  })

  test("one at an equal seq still applies, since an idle close does not bump seq", () => {
    const state = frames(
      painted(),
      status({
        seq: 10,
        sweeps: 8,
        thresholds: { symbols: 42, warmingUp: 7 },
      })
    )
    expect(state.sweepsTotal).toBe(8)
    expect(state.thresholds).toEqual({ symbols: 42, warmingUp: 7 })
  })
})

describe("the threshold counts", () => {
  test("follow the status, which is the relay's live count", () => {
    const state = frames(
      painted(),
      status({ thresholds: { symbols: 42, warmingUp: 7 } })
    )
    expect(state.thresholds).toEqual({ symbols: 42, warmingUp: 7 })
  })

  test("a new day does not carry yesterday's", () => {
    const state = frames(
      painted({ thresholds: { symbols: 42, warmingUp: 7 } }),
      sweepFrame(sweep(1, { day: "2026-10-30", seq: 11 }))
    )
    expect(state.thresholds).toEqual({ symbols: 0, warmingUp: 0 })
  })
})

describe("the feed", () => {
  test("upserts by key, newest first, ties by symbol then number", () => {
    const at = IsoDateTime.make("2026-10-29T06:30:00.000Z")
    const state = frames(
      painted(),
      sweepFrame(sweep(5, { announcedAt: at, seq: 11 })),
      sweepFrame(sweep(4, { announcedAt: at, seq: 11 })),
      sweepFrame(sweep(9, { announcedAt: at, symbol: BBCA, seq: 11 })),
      sweepFrame(sweep(5, { announcedAt: at, seq: 12, open: false }))
    )
    expect(state.sweeps.map((s) => `${s.symbol}${s.firstNumber}`)).toEqual([
      "BBCA9",
      "ENRG4",
      "ENRG5",
      "ENRG1",
    ])
    expect(state.sweeps[2]?.open).toBe(false)
  })

  test("the total counts a new row once, and not one the last status counted", () => {
    const row = sweep(2, { seq: 11 })
    const counted = frames(painted(), sweepFrame(row), sweepFrame(row))
    expect(counted.sweepsTotal).toBe(4)

    const resumed = frames(
      painted(),
      status({ seq: 12, sweeps: 9 }),
      sweepFrame(row),
      sweepFrame(sweep(3, { seq: 12 }))
    )
    expect(resumed.sweepsTotal).toBe(9)
    expect(frames(resumed, sweepFrame(sweep(4, { seq: 13 }))).sweepsTotal).toBe(
      10
    )
  })

  test("resumes from the newest row it heard, and never moves back", () => {
    const state = frames(
      painted(),
      sweepFrame(sweep(2, { seq: 14 })),
      sweepFrame(sweep(3, { seq: 12 }))
    )
    expect(state.seq).toBe(14)
  })

  test("a status never moves the resume point past rows not yet received", () => {
    expect(frames(painted(), status({ seq: 15 })).seq).toBe(10)
  })

  test("a later day clears the rows, the board, and the count", () => {
    const state = frames(
      painted(),
      status({ day: "2026-10-30", sweeps: 0, seq: 11 })
    )
    expect(state).toMatchObject({
      day: "2026-10-30",
      sweeps: [],
      leaderboard: [],
      sweepsTotal: 0,
    })
    const next = frames(
      state,
      sweepFrame(sweep(1, { day: "2026-10-30", value: 5, seq: 12 }))
    )
    expect(buyOf(next, ENRG)).toBe(5)
    expect(next.sweepsTotal).toBe(1)
  })

  test("a row of a later day rolls it too", () => {
    const state = frames(
      painted(),
      sweepFrame(sweep(1, { day: "2026-10-30", value: 5, seq: 11 }))
    )
    expect(state.day).toBe("2026-10-30")
    expect(state.sweeps).toHaveLength(1)
    expect(buyOf(state, ENRG)).toBe(5)
  })

  test("earlier rows of a cleared day are dropped", () => {
    const state = frames(painted(), status({ day: "2026-10-30", seq: 11 }))
    expect(addEarlier(state, [sweep(0)]).sweeps).toEqual([])
  })

  test("a threshold frame moves only the resume point", () => {
    const state = frames(painted(), {
      type: "threshold",
      seq: 13,
      threshold: {
        symbol: ENRG,
        threshold: 10,
        warmingUp: true,
        prior: "none",
        ordersToday: 1,
        asOf: null,
      },
    })
    expect(state).toEqual({ ...painted(), seq: 13 })
  })

  test("keeps a bounded list, whose end earlier can walk back to", () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      sweep(10_000 - i, { value: 0 })
    )
    const state = frames(
      painted({ sweeps: many, sweepsTotal: 2000, leaderboard: [] }),
      sweepFrame(sweep(20_000, { seq: 11 }))
    )
    expect(state.sweeps).toHaveLength(2000)
    expect(state.sweeps[0]?.firstNumber).toBe(20_000)
    expect(hasEarlier(state)).toBe(true)
  })

  test("never trims rows the operator loaded through earlier", () => {
    const many = Array.from({ length: 2000 }, (_, i) =>
      sweep(10_000 - i, { value: 0 })
    )
    const held = painted({ sweeps: many, sweepsTotal: 2600, leaderboard: [] })
    const loaded = addEarlier({ ...held, loadedEarlier: true }, [
      sweep(1, { value: 0 }),
    ])
    const state = frames(loaded, sweepFrame(sweep(20_000, { seq: 11 })))
    expect(state.sweeps).toHaveLength(2002)
    expect(state.sweeps.at(-1)?.firstNumber).toBe(1)
  })

  test("a new day trims again", () => {
    const loaded = addEarlier(
      { ...painted({ sweepsTotal: 5 }), loadedEarlier: true },
      [sweep(0, { value: 0 })]
    )
    const next = Array.from({ length: 2001 }, (_, i) =>
      sweepFrame(
        sweep(i, {
          day: "2026-10-30",
          announcedAt: live.asOf ?? undefined,
          seq: 11,
        })
      )
    )
    expect(frames(loaded, ...next).sweeps).toHaveLength(2000)
  })

  test("hasEarlier is whether the total passes what is held", () => {
    expect(hasEarlier(painted({ sweepsTotal: 1 }))).toBe(false)
    expect(hasEarlier(painted({ sweepsTotal: 2 }))).toBe(true)
  })
})

describe("the pills", () => {
  test("status sets the trades pill, and a closed socket demotes both", () => {
    const stale = frames(painted(), status({ freshness: "stale" }))
    expect(stale.provenance.freshness).toBe("stale")

    const open = frames(painted(), status())
    const closed = reduceWhales(
      { ...open, liveprice: { ...live, freshness: "live" } },
      { type: "socket", socket: "closed" }
    )
    expect(closed.provenance.freshness).toBe("stale")
    expect(closed.liveprice.freshness).toBe("stale")
  })

  test("the coverage comes from the paint, then each status, and outlasts a new day", () => {
    const covered = [{ symbol: ENRG, receiving: false }]
    const start = painted({ wallCoverage: covered })
    expect(start.wallCoverage).toEqual(covered)

    const next = [
      { symbol: ENRG, receiving: true },
      { symbol: Symbol.make("BBCA"), receiving: false },
    ]
    const heard = frames(start, status({ wallCoverage: next }))
    expect(heard.wallCoverage).toEqual(next)

    const rolled = frames(
      heard,
      status({ wallCoverage: next, day: "2099-01-01" })
    )
    expect(rolled.wallCoverage).toEqual(next)
  })

  test("liveprice is live while any covered symbol is receiving, from a source", () => {
    const heard = [{ symbol: ENRG, receiving: true }]
    const pill = (patch: Partial<RelayStatus>) =>
      frames(painted(), status(patch)).liveprice.freshness
    expect(pill({ wallCoverage: heard })).toBe("live")
    expect(pill({ wallCoverage: [{ symbol: ENRG, receiving: false }] })).toBe(
      "stale"
    )
    expect(pill({ wallCoverage: heard, source: "none" })).toBe("stale")
  })

  test("silence demotes, and a demo pill stays demo", () => {
    expect(
      reduceWhales(painted(), { type: "silent" }).provenance.freshness
    ).toBe("stale")
    const demo = whalesState(EMPTY_WHALES_TODAY)
    expect(reduceWhales(demo, { type: "silent" })).toBe(demo)
  })
})

describe("loading earlier", () => {
  beforeEach(() => {
    earlierSweeps.mockReset()
    vi.stubGlobal("location", { protocol: "http:", host: "dash" })
    vi.stubGlobal(
      "WebSocket",
      class {
        static OPEN = 1
        close() {}
      }
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test("asks from the last held row, once at a time, and stops at the end", async () => {
    const tail = sweep(1, { value: 200 })
    const store = createWhalesStore({
      ...EMPTY_WHALES_TODAY,
      seq: 10,
      day: DAY,
      sweeps: [tail],
      sweepsTotal: 2,
      leaderboard: [{ symbol: ENRG, buyValue: 500, sellValue: 0 }],
      provenance: live,
    })
    earlierSweeps.mockResolvedValueOnce([sweep(0)])

    const loading = store.loadEarlier()
    void store.loadEarlier()
    await loading

    expect(earlierSweeps).toHaveBeenCalledTimes(1)
    expect(earlierSweeps).toHaveBeenCalledWith({
      data: {
        day: DAY,
        announcedAt: tail.announcedAt,
        symbol: ENRG,
        firstNumber: 1,
      },
    })
    expect(store.getSnapshot().sweeps.map((s) => s.firstNumber)).toEqual([1, 0])

    await store.loadEarlier()
    expect(earlierSweeps).toHaveBeenCalledTimes(1)
  })

  test("a failed page can be asked for again", async () => {
    const store = createWhalesStore({
      ...EMPTY_WHALES_TODAY,
      day: DAY,
      sweeps: [sweep(1)],
      sweepsTotal: 2,
    })
    earlierSweeps.mockRejectedValueOnce(new Error("restarting"))
    await store.loadEarlier()
    earlierSweeps.mockResolvedValueOnce([sweep(0)])
    await store.loadEarlier()
    expect(store.getSnapshot().sweeps).toHaveLength(2)
  })

  test("an empty page ends it, whatever the total says", async () => {
    const store = createWhalesStore({
      ...EMPTY_WHALES_TODAY,
      day: DAY,
      sweeps: [sweep(1)],
      sweepsTotal: 5,
    })
    earlierSweeps.mockResolvedValue([])
    await store.loadEarlier()
    await store.loadEarlier()
    expect(earlierSweeps).toHaveBeenCalledTimes(1)
  })
})

describe("a refetch against rows held", () => {
  const time = (ms: number) =>
    IsoDateTime.make(
      new Date(Date.parse(`${DAY}T06:00:00.000Z`) + ms).toISOString()
    )
  const growing = sweep(1, {
    open: true,
    closedBy: null,
    lots: 100,
    value: 200,
    updatedAt: time(1000),
    seq: 20,
  })
  const closed: Sweep = {
    ...growing,
    open: false,
    closedBy: "idle",
    updatedAt: time(2000),
  }
  const wall = (lotsMatched: number, patch: Partial<Wall> = {}): Wall => ({
    ...bbcaWall,
    day: DAY,
    lotsMatched,
    seq: 20,
    ...patch,
  })
  const today = (patch: Partial<WhalesToday>): WhalesToday => ({
    ...EMPTY_WHALES_TODAY,
    seq: 20,
    day: DAY,
    sweepsTotal: 1,
    leaderboard: [{ symbol: ENRG, buyValue: 200, sellValue: 0 }],
    provenance: live,
    ...patch,
  })
  const reset = (held: Partial<WhalesToday>, fresh: Partial<WhalesToday>) =>
    resetToToday(whalesState(today(held)), today(fresh))

  test("a closed sweep does not go back to growing at the same seq", () => {
    const { sweeps } = reset({ sweeps: [growing] }, { sweeps: [closed] })
    expect(sweeps).toEqual([closed])
  })

  test("a sweep the snapshot has grown past keeps the snapshot's value in the leaderboard", () => {
    const fresh = { ...closed, value: 300 }
    const state = reset(
      { sweeps: [growing] },
      {
        sweeps: [fresh],
        leaderboard: [{ symbol: ENRG, buyValue: 300, sellValue: 0 }],
      }
    )
    expect(state.leaderboard).toEqual([
      { symbol: ENRG, buyValue: 300, sellValue: 0 },
    ])
  })

  test("a wall's lots do not fall at the same seq", () => {
    const fresh = wall(1500, { lastSeen: time(2000) })
    const { walls } = reset(
      { walls: [wall(1429, { lastSeen: time(1000) })] },
      { walls: [fresh] }
    )
    expect(walls).toEqual([fresh])
  })

  test("a wall the snapshot closed stays closed, by its close's time", () => {
    const fresh = wall(1429, {
      lastSeen: time(1000),
      closedAt: time(2000),
      closedBy: "idle",
    })
    const { walls } = reset(
      { walls: [wall(1429, { lastSeen: time(1000) })] },
      { walls: [fresh] }
    )
    expect(walls).toEqual([fresh])
  })

  test("the snapshot wins a tie", () => {
    const state = reset(
      {
        sweeps: [{ ...growing, lots: 1 }],
        walls: [wall(1, { lastSeen: time(1000) })],
      },
      {
        sweeps: [growing],
        walls: [wall(2, { lastSeen: time(1000) })],
      }
    )
    expect(state.sweeps).toEqual([growing])
    expect(state.walls.map((w) => w.lotsMatched)).toEqual([2])
  })

  test("a held row newer than the snapshot's replaces it, in the leaderboard by its change", () => {
    const newer = { ...closed, value: 350 }
    const heldWall = wall(1500, { lastSeen: time(2000) })
    const state = reset(
      { sweeps: [newer], walls: [heldWall] },
      { sweeps: [growing], walls: [wall(1429, { lastSeen: time(1000) })] }
    )
    expect(state.sweeps).toEqual([newer])
    expect(state.walls).toEqual([heldWall])
    expect(state.leaderboard).toEqual([
      { symbol: ENRG, buyValue: 350, sellValue: 0 },
    ])
  })

  test("a held wall's close beats the snapshot's open row with the same last hit", () => {
    const heldWall = wall(1429, {
      lastSeen: time(1000),
      closedAt: time(2000),
      closedBy: "idle",
    })
    const { walls } = reset(
      { walls: [heldWall] },
      { walls: [wall(1429, { lastSeen: time(1000) })] }
    )
    expect(walls).toEqual([heldWall])
  })

  test("a delayed hit the snapshot missed survives, on an open wall", () => {
    const heldWall = wall(1500, { lastSeen: time(1000), hitsSeen: 96 })
    const { walls } = reset(
      { walls: [heldWall] },
      { walls: [wall(1429, { lastSeen: time(1000), hitsSeen: 95 })] }
    )
    expect(walls).toEqual([heldWall])
  })

  test("a delayed hit the snapshot missed survives, on a closed wall", () => {
    const closure = { closedAt: time(2000), closedBy: "idle" } as const
    const heldWall = wall(1500, {
      lastSeen: time(1000),
      hitsSeen: 96,
      ...closure,
    })
    const { walls } = reset(
      { walls: [heldWall] },
      { walls: [wall(1429, { lastSeen: time(1000), ...closure })] }
    )
    expect(walls).toEqual([heldWall])
  })

  test("a row the snapshot lacks survives only at or past its seq", () => {
    const old = sweep(2, { seq: 19 })
    const fresh = sweep(3, { seq: 20 })
    const { sweeps } = reset({ sweeps: [fresh, old] }, { sweeps: [] })
    expect(sweeps).toEqual([fresh])
  })

  describe("then a socket frame older than the snapshot's row", () => {
    const wallFrame = (row: Wall, seq = row.seq): TradeFrame => ({
      type: "wall",
      seq,
      provenance: { ...live, feed: "stockbit-liveprice" },
      wall: row,
      threshold: sweepThreshold,
    })
    const grownClosed: Sweep = { ...closed, value: 300 }
    const closedWall = wall(1500, {
      lastSeen: time(1000),
      closedAt: time(2000),
      closedBy: "idle",
    })
    const snapshot = whalesState(
      today({
        sweeps: [grownClosed],
        leaderboard: [{ symbol: ENRG, buyValue: 300, sellValue: 0 }],
        walls: [closedWall],
      })
    )

    test("a sweep does not reopen or shrink, and the leaderboard and count hold", () => {
      const state = frames(snapshot, sweepFrame(growing))
      expect(state.sweeps).toEqual([grownClosed])
      expect(buyOf(state, ENRG)).toBe(300)
      expect(state.sweepsTotal).toBe(1)
    })

    test("a wall does not reopen or lose lots", () => {
      const older = wall(1429, { lastSeen: time(1000) })
      const state = frames(snapshot, wallFrame(older))
      expect(state.walls).toEqual([closedWall])
    })

    test("a delayed hit applies, though it does not move lastSeen", () => {
      const open = wall(1429, { lastSeen: time(1000) })
      const delayed = wall(1500, { lastSeen: time(1000), hitsSeen: 96 })
      const state = frames(
        whalesState(today({ walls: [open] })),
        wallFrame(delayed)
      )
      expect(state.walls).toEqual([delayed])
    })

    test("a frame with fewer hits at the same time is dropped", () => {
      const held = wall(1500, { lastSeen: time(1000), hitsSeen: 96 })
      const queued = wall(1429, { lastSeen: time(1000), hitsSeen: 95 })
      const state = frames(
        whalesState(today({ walls: [held] })),
        wallFrame(queued)
      )
      expect(state.walls).toEqual([held])
    })

    test("a full tie applies", () => {
      const held = wall(1429, { lastSeen: time(1000) })
      const tied = wall(1429, { lastSeen: time(1000), seq: 21 })
      const state = frames(
        whalesState(today({ walls: [held] })),
        wallFrame(tied)
      )
      expect(state.walls).toEqual([tied])
    })

    test("a sweep at the same version applies", () => {
      const sameTime = { ...grownClosed, lots: 200 }
      const state = frames(snapshot, sweepFrame(sameTime))
      expect(state.sweeps).toEqual([sameTime])
    })

    test("a dropped frame still counts toward the resume and moves the resume point", () => {
      const resuming = frames(
        reduceWhales(snapshot, { type: "socket", socket: "open" }),
        status({ seq: 20, sweeps: 1 })
      )
      const state = frames(
        resuming,
        {
          type: "sweep",
          seq: 25,
          provenance: live,
          sweep: growing,
          threshold: sweepThreshold,
        },
        wallFrame(wall(1429, { lastSeen: time(1000) }), 26)
      )
      expect(state.sweeps).toEqual([grownClosed])
      expect(state.walls).toEqual([closedWall])
      expect(state.resume).toEqual({ upTo: 20, sweeps: 1, walls: 1 })
      expect(state.seq).toBe(26)
    })
  })
})

describe("a reconnect", () => {
  type Fake = {
    onopen: () => void
    onmessage: (e: { data: string }) => void
    onclose: () => void
    url: string
  }
  let sockets: Array<Fake> = []

  beforeEach(() => {
    sockets = []
    whalesToday.mockReset()
    earlierSweeps.mockReset()
    vi.stubGlobal("location", { protocol: "http:", host: "dash" })
    vi.stubGlobal(
      "WebSocket",
      class {
        static OPEN = 1
        constructor(url: string) {
          ;(this as unknown as Fake).url = url
          sockets.push(this as unknown as Fake)
        }
        close() {}
      }
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  const paint: WhalesToday = {
    ...EMPTY_WHALES_TODAY,
    seq: 10,
    day: DAY,
    sweeps: [sweep(1, { value: 200 })],
    sweepsTotal: 1,
    leaderboard: [{ symbol: ENRG, buyValue: 200, sellValue: 0 }],
    provenance: live,
  }

  /** A store whose first socket has just opened. */
  const connected = async (today = paint) => {
    const store = createWhalesStore(today)
    const stop = store.subscribe(() => undefined)
    await settle()
    const socket = sockets.at(-1)
    if (!socket) throw new Error("no socket")
    socket.onopen()
    const hear = (frame: TradeFrame) =>
      socket.onmessage({ data: JSON.stringify(frame) })
    return { store, stop, hear }
  }

  /** The relay's capped resume: 500 rows, oldest first, the last at seq 600. */
  const capped = Array.from({ length: 500 }, (_, i) =>
    sweep(1000 + i, { value: 1, seq: 101 + i })
  )

  /** The relay's answer after a gap: a contiguous newest page and true totals. */
  const healed: WhalesToday = {
    ...paint,
    seq: 600,
    sweeps: capped.slice(-2).reverse(),
    sweepsTotal: 700,
    leaderboard: [{ symbol: ENRG, buyValue: 900, sellValue: 0 }],
  }

  test("after a capped resume it refetches today and resets to a contiguous page", async () => {
    whalesToday.mockResolvedValue(healed)
    const { store, stop, hear } = await connected()
    hear(status({ seq: 600, sweeps: 300 }))
    for (const row of capped) hear(sweepFrame(row))
    await settle()
    stop()

    expect(whalesToday).toHaveBeenCalledTimes(1)
    const state = store.getSnapshot()
    expect(state.sweeps.map((s) => s.firstNumber)).toEqual([1499, 1498])
    expect(state.sweepsTotal).toBe(700)
    expect(mostSwept(state)).toEqual(healed.leaderboard)
    expect(state.seq).toBe(600)
  })

  describe("a resume of walls", () => {
    const wallFrame = (i: number, seq: number): TradeFrame => ({
      type: "wall",
      seq,
      provenance: { ...live, feed: "stockbit-liveprice" },
      wall: {
        ...bbcaWall,
        day: DAY,
        firstOrderNumber: `20261029${String(i).padStart(10, "0")}`,
        seq,
      },
      threshold: {
        symbol: bbcaWall.symbol,
        threshold: 10,
        warmingUp: true,
        prior: "none",
        ordersToday: 1,
        asOf: null,
      },
    })
    const walls = (length: number) =>
      Array.from({ length }, (_, i) => wallFrame(i, 101 + i))

    test("a full page of walls refetches, with no sweep in the resume", async () => {
      whalesToday.mockResolvedValue(healed)
      const { store, stop, hear } = await connected()
      hear(status({ seq: 600, sweeps: 1 }))
      for (const frame of walls(500)) hear(frame)
      await settle()
      stop()

      expect(whalesToday).toHaveBeenCalledTimes(1)
      expect(store.getSnapshot().sweepsTotal).toBe(700)
    })

    test("each list has its own cap, so 499 of each does not refetch", async () => {
      const { stop, hear } = await connected()
      hear(status({ seq: 2000, sweeps: 1 }))
      for (const frame of walls(499)) hear(frame)
      for (let i = 0; i < 499; i++)
        hear(sweepFrame(sweep(2 + i, { seq: 700 + i })))
      await settle()
      stop()
      expect(whalesToday).not.toHaveBeenCalled()
    })

    test("live walls past the resume never add up to a refetch", async () => {
      const { stop, hear } = await connected()
      hear(status({ seq: 10, sweeps: 1 }))
      for (let i = 0; i < 600; i++) hear(wallFrame(i, 11 + i))
      await settle()
      stop()
      expect(whalesToday).not.toHaveBeenCalled()
    })
  })

  test("a status saying more new rows than a resume can carry refetches, whatever arrives", async () => {
    whalesToday.mockResolvedValue(healed)
    const { stop, hear } = await connected()
    hear(status({ seq: 600, sweeps: 501 }))
    await settle()
    stop()
    expect(whalesToday).toHaveBeenCalledTimes(1)
  })

  test("a short resume does not refetch", async () => {
    const { store, stop, hear } = await connected()
    hear(status({ seq: 12, sweeps: 3 }))
    hear(sweepFrame(sweep(2, { seq: 11 })))
    hear(sweepFrame(sweep(3, { seq: 12 })))
    await settle()
    stop()
    expect(whalesToday).not.toHaveBeenCalled()
    expect(store.getSnapshot().sweeps).toHaveLength(3)
  })

  test("live frames past the resume never add up to a refetch", async () => {
    const { stop, hear } = await connected()
    hear(status({ seq: 10, sweeps: 1 }))
    for (let i = 0; i < 600; i++)
      hear(sweepFrame(sweep(2 + i, { seq: 11 + i })))
    await settle()
    stop()
    expect(whalesToday).not.toHaveBeenCalled()
  })

  test("a row heard while the refetch ran survives it, in the totals once", async () => {
    let answer: (today: WhalesToday) => void = () => undefined
    whalesToday.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    const { store, stop, hear } = await connected()
    hear(status({ seq: 600, sweeps: 501 }))
    hear(sweepFrame(sweep(5000, { value: 50, seq: 601 })))
    answer(healed)
    await settle()
    stop()

    const state = store.getSnapshot()
    expect(state.sweeps[0]?.firstNumber).toBe(5000)
    expect(state.sweepsTotal).toBe(701)
    expect(mostSwept(state)[0]?.buyValue).toBe(950)
    expect(state.seq).toBe(601)
  })

  test("a failed refetch is tried again on the next frame", async () => {
    whalesToday.mockRejectedValueOnce(new Error("restarting"))
    whalesToday.mockResolvedValue(healed)
    const { store, stop, hear } = await connected()
    hear(status({ seq: 600, sweeps: 501 }))
    await settle()
    hear(status({ seq: 600, sweeps: 700 }))
    await settle()
    stop()
    expect(store.getSnapshot().sweeps).toHaveLength(2)
  })

  describe("a refetch answered with an older day", () => {
    const NEXT_DAY = "2026-10-30"
    const todays = sweep(7000, { day: NEXT_DAY, value: 50, seq: 601 })

    /** A gap's refetch still running when the next day's first row arrives. */
    const rolledDuringRefetch = async () => {
      let answer: (today: WhalesToday) => void = () => undefined
      whalesToday.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve
        })
      )
      const open = await connected()
      open.hear(status({ seq: 600, sweeps: 501 }))
      open.hear(sweepFrame(todays))
      return { ...open, answer }
    }

    test("keeps the newer day's rows, and its gap", async () => {
      const { store, stop, answer } = await rolledDuringRefetch()
      const before = store.getSnapshot()
      answer(healed)
      await settle()
      stop()
      expect(store.getSnapshot()).toBe(before)
      expect(before.gap).toBe(true)
      expect(before.sweeps).toEqual([todays])
    })

    test("refetches on the next event, and takes a snapshot of the same day", async () => {
      const { store, stop, hear, answer } = await rolledDuringRefetch()
      answer(healed)
      await settle()
      whalesToday.mockResolvedValueOnce({
        ...healed,
        day: NEXT_DAY,
        seq: 601,
        sweeps: [todays],
        sweepsTotal: 1,
        leaderboard: [{ symbol: ENRG, buyValue: 50, sellValue: 0 }],
      })
      hear(status({ day: NEXT_DAY, seq: 601, sweeps: 1 }))
      await settle()
      stop()

      expect(whalesToday).toHaveBeenCalledTimes(2)
      const state = store.getSnapshot()
      expect(state.gap).toBe(false)
      expect(state.sweeps).toEqual([todays])
      expect(buyOf(state, ENRG)).toBe(50)
    })

    test("does not throw away an earlier page in flight", async () => {
      let page: (rows: ReadonlyArray<Sweep>) => void = () => undefined
      earlierSweeps.mockReturnValue(
        new Promise((resolve) => {
          page = resolve
        })
      )
      const { store, stop, hear, answer } = await rolledDuringRefetch()
      hear(status({ day: NEXT_DAY, seq: 601, sweeps: 2 }))
      const loading = store.loadEarlier()
      answer(healed)
      await settle()
      page([sweep(6000, { day: NEXT_DAY })])
      await loading
      stop()
      expect(store.getSnapshot().sweeps.map((s) => s.firstNumber)).toEqual([
        7000, 6000,
      ])
    })
  })

  test("a next-day refetch landing before the old day's resume drains keeps that day clean", async () => {
    const NEXT_DAY = "2026-10-30"
    const todays = sweep(7000, { day: NEXT_DAY, value: 50, seq: 700 })
    const todaysWall = { ...bbcaWall, day: NEXT_DAY, seq: 700 }
    whalesToday.mockResolvedValue({
      ...paint,
      day: NEXT_DAY,
      seq: 700,
      sweeps: [todays],
      sweepsTotal: 1,
      leaderboard: [{ symbol: ENRG, buyValue: 50, sellValue: 0 }],
      walls: [todaysWall],
    })
    const { store, stop, hear } = await connected()
    hear(status({ seq: 650, sweeps: 501 }))
    await settle()
    expect(store.getSnapshot().day).toBe(NEXT_DAY)

    hear(sweepFrame(sweep(2, { value: 999, seq: 640 })))
    hear({
      type: "wall",
      seq: 641,
      provenance: { ...live, feed: "stockbit-liveprice" },
      wall: { ...bbcaWall, day: DAY, seq: 641 },
      threshold: sweepThreshold,
    })
    const drained = store.getSnapshot()
    hear(status({ day: NEXT_DAY, seq: 701, sweeps: 1 }))
    const state = store.getSnapshot()
    stop()

    for (const held of [drained, state]) {
      expect(held.sweeps).toEqual([todays])
      expect(held.walls).toEqual([todaysWall])
      expect(held.sweepsTotal).toBe(1)
      expect(buyOf(held, ENRG)).toBe(50)
    }
  })

  describe("a status older than the accepted snapshot", () => {
    const coverage = [{ symbol: BBCA, receiving: true }]
    const thresholds = { symbols: 42, warmingUp: 7 }
    const snapshot: WhalesToday = {
      ...paint,
      seq: 700,
      sweepsTotal: 700,
      wallCoverage: coverage,
      thresholds,
    }

    /** A capped resume whose refetch landed before the handshake's frames finished. */
    const refetched = async () => {
      whalesToday.mockResolvedValue(snapshot)
      const heard = await connected()
      heard.hear(status({ seq: 650, sweeps: 501 }))
      await settle()
      expect(heard.store.getSnapshot().sweepsTotal).toBe(700)
      return heard
    }

    test("a lower seq replaces no counter, coverage, feed, or status", async () => {
      const { store, stop, hear } = await refetched()
      const before = store.getSnapshot()
      hear(
        status({
          seq: 650,
          sweeps: 501,
          freshness: "stale",
          source: "none",
          wallCoverage: [],
          thresholds: { symbols: 1, warmingUp: 1 },
        })
      )
      const state = store.getSnapshot()
      stop()

      expect(state.sweepsTotal).toBe(700)
      expect(state.countedSeq).toBe(700)
      expect(state.wallCoverage).toEqual(coverage)
      expect(state.thresholds).toEqual(thresholds)
      expect(state.provenance).toEqual(before.provenance)
      expect(state.liveprice).toEqual(before.liveprice)
      expect(state.status).toEqual(before.status)
    })

    test("the next socket measures its missed rows from the snapshot's total", async () => {
      const { stop, hear } = await refetched()
      hear(status({ seq: 650, sweeps: 501 }))
      whalesToday.mockClear()
      const latest = sockets.at(-1)
      if (!latest) throw new Error("no socket")
      latest.onopen()
      hear(status({ seq: 900, sweeps: 1100 }))
      await settle()
      stop()
      expect(whalesToday).not.toHaveBeenCalled()
    })

    test("as a socket's first status, it finds no gap in an earlier day's count", async () => {
      const { store, stop, hear } = await connected({
        ...paint,
        day: "2026-10-30",
        seq: 700,
        sweepsTotal: 1,
      })
      hear(status({ seq: 650, sweeps: 501 }))
      await settle()
      const { gap, sweepsTotal } = store.getSnapshot()
      stop()
      expect(whalesToday).not.toHaveBeenCalled()
      expect(gap).toBe(false)
      expect(sweepsTotal).toBe(1)
    })

    test("as a socket's first status, it still bounds that socket's resume", async () => {
      const { stop, hear, store } = await connected({
        ...paint,
        seq: 700,
        sweepsTotal: 700,
      })
      hear(status({ seq: 650, sweeps: 650 }))
      expect(store.getSnapshot().resume).toEqual({
        upTo: 650,
        sweeps: 0,
        walls: 0,
      })
      stop()
    })
  })

  test("a live sweep during the first earlier page cannot trim the tail it was asked after", async () => {
    let page: (rows: ReadonlyArray<Sweep>) => void = () => undefined
    earlierSweeps.mockReturnValue(
      new Promise((resolve) => {
        page = resolve
      })
    )
    const held = Array.from({ length: 2000 }, (_, i) =>
      sweep(10_000 - i, { value: 0 })
    )
    const { store, stop, hear } = await connected({
      ...paint,
      sweeps: held,
      sweepsTotal: 2600,
    })
    const loading = store.loadEarlier()
    hear(sweepFrame(sweep(20_000, { seq: 11 })))
    page([sweep(8000, { value: 0 })])
    await loading
    stop()
    expect(
      store
        .getSnapshot()
        .sweeps.slice(-2)
        .map((s) => s.firstNumber)
    ).toEqual([8001, 8000])
  })

  test("an earlier page asked for before the reset cannot make a hole after it", async () => {
    let page: (rows: ReadonlyArray<Sweep>) => void = () => undefined
    earlierSweeps.mockReturnValue(
      new Promise((resolve) => {
        page = resolve
      })
    )
    whalesToday.mockResolvedValue(healed)
    const { store, stop, hear } = await connected({ ...paint, sweepsTotal: 2 })
    const loading = store.loadEarlier()
    hear(status({ seq: 600, sweeps: 700 }))
    await settle()
    page([sweep(0)])
    await loading
    stop()
    expect(store.getSnapshot().sweeps.map((s) => s.firstNumber)).toEqual([
      1499, 1498,
    ])
  })
})
