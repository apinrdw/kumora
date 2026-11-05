import { describe, expect, test } from "vitest"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { Trade, Wall } from "@/domain/trade"
import { createWhales, sketchOf } from "@/relay/whale"
import {
  createWalls,
  expireWalls,
  feedHit,
  feedWallTrades,
  makerHit,
  restoreWalls,
} from "@/relay/whale-walls"
import type { MakerHit } from "@/relay/whale-walls"

const BBCA = Symbol.make("BBCA")
const COVERAGE = new Set([BBCA])
const T0 = Date.parse("2026-10-29T06:30:00.000Z")
const at = (ms: number) => IsoDateTime.make(new Date(T0 + ms).toISOString())

/** A symbol whose threshold is 10 lots. */
const whales = () =>
  createWhales({ own: new Map([[BBCA, sketchOf([10])]]), market: null })

const ORDER = "202610290002329192"
const order = (n: number) => `20261029${String(n).padStart(10, "0")}`
const match = (tradeNumber: number) =>
  `20261029${String(tradeNumber).padStart(10, "0")}`

const hit = (tradeNumber: number, ms: number, over: Partial<MakerHit> = {}) =>
  ({
    symbol: BBCA,
    side: "offer",
    price: 5050,
    lots: 6,
    orderNumber: ORDER,
    matchNumber: match(tradeNumber),
    receivedAt: at(ms),
    ...over,
  }) satisfies MakerHit

const trade = (tradeNumber: number, ms: number, over: Partial<Trade> = {}) =>
  ({
    symbol: BBCA,
    price: 5050,
    volume: 600,
    side: "buy",
    tradedAt: at(ms),
    tradeNumber,
    board: "RG",
    value: 1,
    receivedAt: at(ms),
    change: 0,
    ...over,
  }) satisfies Trade

/** Runs `steps` against one set of walls, keeping each row's last state. */
const desk = () => {
  const walls = createWalls()
  const w = whales()
  const rows = new Map<string, Wall>()
  const keep = ({ walls: changed }: { walls: ReadonlyArray<Wall> }) => {
    for (const row of changed) rows.set(row.firstOrderNumber, row)
    return changed
  }
  return {
    walls,
    rows,
    frame: (h: MakerHit, seq = 1) => keep(feedHit(walls, w, h, seq)),
    land: (trades: ReadonlyArray<Trade>, seq = 1) =>
      keep(feedWallTrades(walls, w, trades, COVERAGE, seq)),
    tick: (ms: number, seq = 1) => keep(expireWalls(walls, w, T0 + ms, seq)),
  }
}

/** Two hits whose trades landed, enough to cross the 10 lots. */
const crossed = () => {
  const d = desk()
  d.frame(hit(1, 0))
  d.frame(hit(2, 10))
  d.land([trade(1, 40), trade(2, 50)])
  return d
}

describe("the join", () => {
  test("a hit counts when its trade lands, and not before", () => {
    const d = desk()
    expect(d.frame(hit(1, 0, { lots: 20 }))).toEqual([])
    expect(d.rows.size).toBe(0)
    d.land([trade(1, 40)])
    expect(d.rows.get(ORDER)).toMatchObject({ hitsSeen: 1, lotsMatched: 20 })
  })

  test("a trade that landed first counts at the frame", () => {
    const d = desk()
    d.land([trade(1, 0)])
    d.frame(hit(1, 40, { lots: 20 }))
    expect(d.rows.get(ORDER)?.hitsSeen).toBe(1)
  })

  test.each(["TN", "NG"])(
    "a %s hit does not count, either way round",
    (board) => {
      const first = desk()
      first.frame(hit(1, 0, { lots: 20 }))
      first.land([trade(1, 40, { board })])
      first.tick(6000)
      expect(first.rows.size).toBe(0)

      const second = desk()
      second.land([trade(1, 0, { board })])
      second.frame(hit(1, 40, { lots: 20 }))
      second.tick(6000)
      expect(second.rows.size).toBe(0)
    }
  )

  test.each(["TN", "NG"])(
    "a %s hit resent after the 5 s repeat window does not count",
    (board) => {
      const d = desk()
      d.frame(hit(1, 0, { lots: 20 }))
      d.land([trade(1, 40, { board })])
      d.tick(5100)
      d.frame(hit(1, 5200, { lots: 20 }))
      d.tick(10_300)
      expect(d.rows.size).toBe(0)
    }
  )

  test("a TN hit first heard past 5 s after its trade does not count", () => {
    const d = desk()
    d.land([trade(1, 0, { board: "TN" })])
    d.tick(5100)
    d.frame(hit(1, 5200, { lots: 20 }))
    d.tick(10_300)
    expect(d.rows.size).toBe(0)
  })

  test("a frame whose trade never lands counts after 5 s", () => {
    const d = desk()
    d.frame(hit(1, 0, { lots: 20 }))
    expect(d.tick(5000)).toEqual([])
    d.tick(5001)
    expect(d.rows.get(ORDER)).toMatchObject({
      hitsSeen: 1,
      lastSeen: at(0),
    })
  })

  test("a repeated match number drops", () => {
    const d = desk()
    d.frame(hit(1, 0, { lots: 6 }))
    d.frame(hit(1, 10, { lots: 6 }))
    d.land([trade(1, 40)])
    d.tick(6000)
    expect(d.rows.size).toBe(0)

    const landed = desk()
    landed.frame(hit(1, 0, { lots: 20 }))
    landed.land([trade(1, 40)])
    landed.frame(hit(1, 50, { lots: 20 }))
    expect(landed.rows.get(ORDER)?.hitsSeen).toBe(1)
  })

  describe("a counted match resent after the 5 s repeat window", () => {
    test("whose trade has gone counts nothing, once the frame's wait ends", () => {
      const d = desk()
      d.frame(hit(1, 0))
      d.land([trade(1, 40)])
      d.tick(5100)
      d.frame(hit(1, 5200))
      d.tick(10_300)
      expect(d.rows.size).toBe(0)
    })

    test("whose trade is still landed counts nothing", () => {
      const d = desk()
      d.frame(hit(1, 0))
      d.land([trade(1, 4000)])
      d.tick(5100)
      d.frame(hit(1, 5200))
      expect(d.rows.size).toBe(0)
    })

    test("that was counted with no trade counts nothing", () => {
      const d = desk()
      d.frame(hit(1, 0))
      d.tick(5100)
      d.frame(hit(1, 5200))
      d.tick(10_300)
      expect(d.rows.size).toBe(0)
    })

    test("on a wall changes no row and sends no frame", () => {
      const d = crossed()
      const before = d.rows.get(ORDER)
      d.tick(5100)
      expect(d.frame(hit(1, 5200), 2)).toEqual([])
      expect(d.tick(10_300, 2)).toEqual([])
      expect(d.rows.get(ORDER)).toEqual(before)
    })

    test("on a wall gone idle does not reopen it", () => {
      const d = crossed()
      d.tick(60_100)
      const idle = d.rows.get(ORDER)
      expect(idle?.closedBy).toBe("idle")
      expect(d.frame(hit(1, 60_200), 2)).toEqual([])
      expect(d.tick(65_300, 2)).toEqual([])
      expect(d.rows.get(ORDER)).toEqual(idle)
    })

    test("leaves the order's new matches counting", () => {
      const d = crossed()
      d.tick(5100)
      d.frame(hit(1, 5200))
      d.land([trade(3, 5300)])
      d.frame(hit(3, 5300))
      d.tick(10_300)
      expect(d.rows.get(ORDER)).toMatchObject({ hitsSeen: 3, lotsMatched: 18 })
    })

    test("on a maker of two orders counts nothing", () => {
      const d = desk()
      d.frame(hit(1, 0, { orderNumber: order(100), lots: 4 }))
      d.frame(hit(2, 0, { orderNumber: order(105), lots: 4 }))
      d.land([trade(1, 40), trade(2, 40)])
      d.tick(5100)
      d.frame(hit(2, 5200, { orderNumber: order(105), lots: 4 }))
      d.tick(10_300)
      expect(d.rows.size).toBe(0)
    })
  })

  test("the index keeps only the wall coverage's trades", () => {
    const walls = createWalls()
    feedWallTrades(walls, whales(), [trade(1, 0)], new Set(), 1)
    expect(walls.joins.size).toBe(0)
  })

  describe("a symbol that left the wall coverage", () => {
    const NOT_COVERED = new Set<Symbol>()

    test("stops entering the index, and its empty join goes", () => {
      const walls = createWalls()
      const w = whales()
      feedWallTrades(walls, w, [trade(1, 0)], COVERAGE, 1)
      feedWallTrades(walls, w, [trade(2, 5000)], NOT_COVERED, 1)
      expireWalls(walls, w, T0 + 5001, 1)
      expect(walls.joins.has(BBCA)).toBe(false)
    })

    test("a gone wall keeps its join and takes no more trades", () => {
      const d = crossed()
      d.tick(61_000)
      const { walls } = d
      feedWallTrades(walls, whales(), [trade(9, 61_100)], NOT_COVERED, 1)
      expect(walls.joins.get(BBCA)?.landed.size).toBe(0)
      expect(walls.joins.get(BBCA)?.makers).toHaveLength(1)
    })

    test("an open wall still closes on a through trade", () => {
      const walls = createWalls()
      const w = whales()
      feedHit(walls, w, hit(1, 0, { lots: 20 }), 1)
      feedWallTrades(walls, w, [trade(1, 40)], COVERAGE, 1)
      const { walls: sent } = feedWallTrades(
        walls,
        w,
        [trade(2, 50, { price: 5075 })],
        NOT_COVERED,
        2
      )
      expect(sent[0]).toMatchObject({
        closedAt: at(50),
        closedBy: "traded-through",
      })
    })

    test("a TN trade it had then makes a later frame for it count nothing", () => {
      const walls = createWalls()
      const w = whales()
      feedWallTrades(walls, w, [trade(1, 0, { board: "TN" })], NOT_COVERED, 1)
      feedHit(walls, w, hit(1, 5200, { lots: 20 }), 1)
      expect(expireWalls(walls, w, T0 + 10_300, 1).walls).toEqual([])
    })

    test("a held hit still joins its trade", () => {
      const walls = createWalls()
      const w = whales()
      feedHit(walls, w, hit(1, 0, { lots: 20 }), 1)
      const { walls: sent } = feedWallTrades(
        walls,
        w,
        [trade(1, 40)],
        NOT_COVERED,
        1
      )
      expect(sent[0]).toMatchObject({ hitsSeen: 1, lotsMatched: 20 })
    })
  })
})

describe("the threshold", () => {
  test("a wall crossing reaches the threshold exactly, and keeps what judged it", () => {
    const d = crossed()
    expect(d.rows.get(ORDER)).toMatchObject({
      symbol: BBCA,
      day: "2026-10-29",
      side: "offer",
      price: 5050,
      hitsSeen: 2,
      lotsMatched: 12,
      threshold: 10,
      prior: "own",
      warmingUp: true,
      firstOrderNumber: ORDER,
      memberOrderNumbers: [ORDER],
      closedAt: null,
    })
  })

  test("a row's day is its match's, whenever the frame arrives", () => {
    const d = desk()
    const late = IsoDateTime.make("2026-10-31T06:30:00.000Z")
    d.frame(hit(1, 0, { lots: 20, receivedAt: late }))
    d.land([trade(1, 40)])
    expect(d.rows.get(ORDER)?.day).toBe("2026-10-29")
  })

  test("below the threshold nothing is announced", () => {
    const d = desk()
    d.frame(hit(1, 0, { lots: 9 }))
    d.land([trade(1, 40)])
    expect(d.rows.size).toBe(0)
  })

  test("with no threshold nothing flags", () => {
    const walls = createWalls()
    const none = createWhales()
    feedHit(walls, none, hit(1, 0, { lots: 1e6 }), 1)
    const { walls: rows } = feedWallTrades(
      walls,
      none,
      [trade(1, 40)],
      COVERAGE,
      1
    )
    expect(rows).toEqual([])
  })

  test("an announced wall sends each hit in its last state", () => {
    const d = crossed()
    d.frame(hit(3, 60))
    d.frame(hit(4, 70))
    const sent = d.land([trade(3, 80), trade(4, 90)], 7)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ hitsSeen: 4, lotsMatched: 24, seq: 7 })
  })
})

describe("the merge", () => {
  const near = (n: number, ms: number, over: Partial<MakerHit> = {}) =>
    hit(n, ms, { orderNumber: order(n * 100), lots: 4, ...over })

  const landing = (...hits: ReadonlyArray<ReturnType<typeof near>>) => {
    const d = desk()
    for (const h of hits) d.frame(h)
    d.land(hits.map((h) => trade(Number(h.matchNumber.slice(8)), 1100)))
    return d
  }

  test("orders within 10 and 1 s are one wall", () => {
    const d = landing(
      near(1, 0),
      near(2, 0, { orderNumber: order(110) }),
      near(3, 1000, { orderNumber: order(120) })
    )
    expect(d.rows.get(order(100))).toMatchObject({
      hitsSeen: 3,
      lotsMatched: 12,
      memberOrderNumbers: [order(100), order(110), order(120)],
    })
  })

  test.each([
    ["more than 10 apart", { orderNumber: order(111) }, 0],
    ["more than 1 s apart", { orderNumber: order(110) }, 1001],
    ["at another price", { orderNumber: order(110), price: 5075 }, 0],
    ["on the other side", { orderNumber: order(110), side: "bid" as const }, 0],
  ])("orders %s stay apart", (_, over, ms) => {
    const d = landing(near(1, 0), near(2, ms, over), near(3, ms, over))
    expect(d.rows.get(order(100))).toBeUndefined()
  })

  describe("an order whose first frame is still waiting for its trade", () => {
    const FIRST = order(100)
    const NEAR = order(110)
    const frameOf = (
      d: ReturnType<typeof desk>,
      tradeNumber: number,
      ms: number,
      orderNumber: string,
      lots = 4
    ) => {
      d.land([trade(tradeNumber, ms)])
      return d.frame(hit(tradeNumber, ms, { orderNumber, lots }))
    }

    test("an order first heard past 1 s after it does not merge, and no false wall comes", () => {
      const d = desk()
      d.frame(hit(1, 0, { orderNumber: FIRST, lots: 4 }))
      frameOf(d, 2, 1000, FIRST)
      frameOf(d, 3, 1500, NEAR)
      d.tick(5001)
      expect(d.rows.size).toBe(0)
    })

    test("an order first heard at 1 s after it still merges", () => {
      const d = desk()
      d.frame(hit(1, 0, { orderNumber: FIRST, lots: 4 }))
      frameOf(d, 2, 1000, FIRST)
      frameOf(d, 3, 1000, NEAR)
      d.tick(5001)
      expect(d.rows.get(FIRST)).toMatchObject({
        lotsMatched: 12,
        memberOrderNumbers: [FIRST, NEAR],
      })
    })

    test("the merging order's own held frame counts as its first", () => {
      const d = desk()
      d.frame(hit(1, 0, { orderNumber: NEAR, lots: 4 }))
      frameOf(d, 2, 1100, FIRST)
      frameOf(d, 3, 1500, NEAR)
      d.tick(5001)
      expect(d.rows.size).toBe(0)
    })

    test("the row's first seen is that frame's", () => {
      const d = desk()
      d.frame(hit(1, 0, { orderNumber: FIRST, lots: 4 }))
      frameOf(d, 2, 1000, FIRST, 20)
      expect(d.rows.get(FIRST)?.firstSeen).toBe(at(0))
    })

    test("past 5 s the record goes, and its empty join with it", () => {
      const d = desk()
      d.land([trade(1, 0, { board: "TN" })])
      d.frame(hit(1, 0, { orderNumber: FIRST }))
      d.tick(5001)
      expect(d.walls.joins.has(BBCA)).toBe(false)
    })

    test.each([
      ["at 5 s still sets", 5000, 0],
      ["past 5 s does not set", 5001, 5001],
    ])("a frame %s the first seen", (_, ms, firstSeen) => {
      const d = desk()
      d.land([trade(1, 0, { board: "TN" })])
      d.frame(hit(1, 0, { orderNumber: FIRST }))
      frameOf(d, 2, ms, FIRST, 20)
      expect(d.rows.get(FIRST)?.firstSeen).toBe(at(firstSeen))
    })
  })

  describe("an order first heard before the maker it merges into", () => {
    const EARLY = order(100)
    const LATE = order(105)
    const AFTER = order(110)
    const mergedLate = (lateLots = 4) => {
      const d = desk()
      d.frame(hit(1, 0, { orderNumber: EARLY, lots: 4 }))
      d.land([trade(2, 900)])
      d.frame(hit(2, 900, { orderNumber: LATE, lots: lateLots }))
      d.land([trade(1, 950)])
      return d
    }

    test("the 1 s window runs from the earliest member, so no false wall comes", () => {
      const d = mergedLate()
      d.land([trade(3, 1500)])
      d.frame(hit(3, 1500, { orderNumber: AFTER, lots: 4 }))
      d.tick(5001)
      expect(d.rows.size).toBe(0)
    })

    test("the row's first seen moves back to that member's", () => {
      const d = mergedLate(20)
      expect(d.rows.get(LATE)?.firstSeen).toBe(at(0))
    })

    test("a member heard later leaves the first seen where it is", () => {
      const d = mergedLate(20)
      d.land([trade(3, 950)])
      d.frame(hit(3, 950, { orderNumber: AFTER, lots: 4 }))
      expect(d.rows.get(LATE)).toMatchObject({
        firstSeen: at(0),
        memberOrderNumbers: [LATE, EARLY, AFTER],
      })
    })
  })

  test("the comparison survives numbers above 2^53", () => {
    const low = "202610290002329192"
    const high = "202610290002329193"
    expect(Number(low)).toBe(Number(high))
    const d = landing(
      near(1, 0, { orderNumber: low }),
      near(2, 0, { orderNumber: high }),
      near(3, 0, { orderNumber: high })
    )
    expect(d.rows.get(low)?.memberOrderNumbers).toEqual([low, high])
  })
})

describe("a wall's lifetime", () => {
  test("an RG trade through the price closes it", () => {
    const d = crossed()
    const sent = d.land([trade(9, 200, { price: 5075 })], 9)
    expect(sent[0]).toMatchObject({
      closedBy: "traded-through",
      closedAt: at(200),
      seq: 9,
    })
  })

  test("a bid wall closes below its price, an offer wall does not", () => {
    const d = crossed()
    expect(d.land([trade(9, 200, { price: 5025 })])).toEqual([])
    const bid = desk()
    bid.frame(hit(1, 0, { side: "bid", lots: 20 }))
    bid.land([trade(1, 40)])
    expect(bid.land([trade(2, 50, { price: 5075 })])).toEqual([])
    expect(bid.land([trade(3, 60, { price: 5025 })])[0]?.closedBy).toBe(
      "traded-through"
    )
  })

  test.each([
    ["NG", { board: "NG" }],
    ["TN", { board: "TN" }],
    ["unspecified-side", { side: "unspecified" as const }],
  ])("a %s trade through the price does not close it", (_, over) => {
    const d = crossed()
    expect(d.land([trade(9, 200, { price: 9000, ...over })])).toEqual([])
    expect(d.rows.get(ORDER)?.closedAt).toBeNull()
  })

  describe("a hit with no alarm since the last one", () => {
    /** One landed hit of 6 lots at the start, under the 10 lots. */
    const unannounced = () => {
      const d = desk()
      d.frame(hit(1, 0))
      d.land([trade(1, 40)])
      return d
    }

    test("past 60 s an unannounced maker is forgotten, and the hit starts a new one", () => {
      const d = unannounced()
      d.land([trade(2, 60_000), trade(3, 60_000)])

      expect(d.frame(hit(2, 60_001))).toEqual([])
      expect(d.rows.size).toBe(0)

      const [row] = d.frame(hit(3, 60_002))
      expect(row).toMatchObject({
        hitsSeen: 2,
        lotsMatched: 12,
        firstSeen: at(60_001),
      })
    })

    test("at 60 s an unannounced maker still counts the hit", () => {
      const d = unannounced()
      d.land([trade(2, 60_000)])

      expect(d.frame(hit(2, 60_000))[0]).toMatchObject({
        hitsSeen: 2,
        lotsMatched: 12,
        firstSeen: at(0),
      })
    })

    test("past 60 s an announced wall keeps its row and its count", () => {
      const d = crossed()
      d.land([trade(3, 70_000)])

      expect(d.frame(hit(3, 70_001))[0]).toMatchObject({
        hitsSeen: 3,
        lotsMatched: 18,
        firstSeen: at(0),
        closedAt: null,
      })
    })
  })

  test("it goes after 60 s with no hit, and not at 60 s", () => {
    const d = crossed()
    expect(d.tick(60_000)).toEqual([])
    const sent = d.tick(60_011, 5)
    expect(sent[0]).toMatchObject({
      closedBy: "idle",
      closedAt: at(60_011),
      lastSeen: at(10),
      seq: 5,
    })
    expect(d.tick(90_000)).toEqual([])
  })

  test("an unannounced maker that goes is forgotten, and starts again from nothing", () => {
    const d = desk()
    d.frame(hit(1, 0))
    d.land([trade(1, 40)])
    d.tick(61_000)
    d.frame(hit(2, 61_100))
    d.land([trade(2, 61_150)])
    expect(d.rows.size).toBe(0)
  })

  test("a later hit on a wall gone by idle reopens the row and keeps its counts", () => {
    const d = crossed()
    d.tick(61_000)
    d.frame(hit(3, 62_000))
    d.land([trade(3, 62_040)])
    expect(d.rows.get(ORDER)).toMatchObject({
      hitsSeen: 3,
      lotsMatched: 18,
      closedAt: null,
      closedBy: null,
    })
  })

  describe("a wall gone by idle whose price a later trade goes through", () => {
    const through = { price: 5075 }
    const gone = () => {
      const d = crossed()
      d.tick(61_000)
      return d
    }

    test("is sent as traded-through, at that trade's time", () => {
      const sent = gone().land([trade(9, 61_100, through)], 7)
      expect(sent).toMatchObject([
        {
          firstOrderNumber: ORDER,
          closedAt: at(61_100),
          closedBy: "traded-through",
          seq: 7,
        },
      ])
    })

    test("a later hit counts and does not reopen it", () => {
      const d = gone()
      d.land([trade(9, 61_100, through)])
      d.frame(hit(10, 62_000))
      d.land([trade(10, 62_040)])
      expect(d.rows.get(ORDER)).toMatchObject({
        hitsSeen: 3,
        lotsMatched: 18,
        closedAt: at(61_100),
        closedBy: "traded-through",
      })
    })

    test("a second through trade leaves its close where it is", () => {
      const d = gone()
      d.land([trade(9, 61_100, through)])
      expect(d.land([trade(10, 61_200, through)])).toEqual([])
      expect(d.rows.get(ORDER)?.closedAt).toBe(at(61_100))
    })

    test("a trade that does not go through it leaves it idle and reopenable", () => {
      const d = gone()
      expect(d.land([trade(9, 61_100)])).toEqual([])
      d.frame(hit(10, 62_000))
      d.land([trade(10, 62_040)])
      expect(d.rows.get(ORDER)).toMatchObject({
        closedAt: null,
        closedBy: null,
      })
    })

    test("a wall restored idle after a restart goes the same way", () => {
      const row = gone().rows.get(ORDER)
      if (!row) throw new Error("no wall")
      const walls = createWalls()
      restoreWalls(walls, [row])
      const { walls: sent } = feedWallTrades(
        walls,
        whales(),
        [trade(9, 61_100, through)],
        COVERAGE,
        2
      )
      expect(sent).toMatchObject([
        { closedAt: at(61_100), closedBy: "traded-through" },
      ])
    })

    test("on a symbol no longer indexed, the trade is not read and it stays idle", () => {
      const { walls } = gone()
      const { walls: sent } = feedWallTrades(
        walls,
        whales(),
        [trade(9, 61_100, through)],
        new Set<Symbol>(),
        2
      )
      expect(sent).toEqual([])
    })
  })

  test("a later hit on a traded-through wall counts and never reopens it", () => {
    const d = crossed()
    d.land([trade(9, 100, { price: 5075 })])
    d.frame(hit(3, 2000))
    d.land([trade(3, 2040)])
    expect(d.rows.get(ORDER)).toMatchObject({
      hitsSeen: 3,
      lotsMatched: 18,
      closedAt: at(100),
      closedBy: "traded-through",
    })
  })

  describe("a hit joined after a later trade through its price", () => {
    const through = trade(2, 10, { price: 5075 })
    const big = { lots: 20 }

    test("closes when the frame comes after both trades", () => {
      const d = desk()
      d.land([trade(1, 0), through])
      d.frame(hit(1, 20, big))
      expect(d.rows.get(ORDER)).toMatchObject({
        hitsSeen: 1,
        lotsMatched: 20,
        lastSeen: at(20),
        closedAt: at(10),
        closedBy: "traded-through",
      })
    })

    test("closes when its own trade lands after the later one", () => {
      const d = desk()
      d.frame(hit(1, 0, big))
      d.land([through, trade(1, 20)])
      expect(d.rows.get(ORDER)).toMatchObject({
        closedAt: at(10),
        closedBy: "traded-through",
      })
    })

    test("closes when its own trade never lands", () => {
      const d = desk()
      d.frame(hit(1, 0, big))
      d.land([through])
      d.tick(5001)
      expect(d.rows.get(ORDER)).toMatchObject({
        closedAt: at(10),
        closedBy: "traded-through",
      })
    })

    test("takes the first through trade's time", () => {
      const d = desk()
      d.land([trade(1, 0), through, trade(3, 15, { price: 5100 })])
      d.frame(hit(1, 20, big))
      expect(d.rows.get(ORDER)?.closedAt).toBe(at(10))
    })

    test("takes back an idle close it reopened", () => {
      const d = crossed()
      d.tick(60_051)
      d.land([trade(3, 60_100), trade(4, 60_110, { price: 5075 })])
      d.frame(hit(3, 60_120))
      expect(d.rows.get(ORDER)).toMatchObject({
        closedAt: at(60_110),
        closedBy: "traded-through",
      })
    })

    test("leaves no trace of an order under the threshold", () => {
      const d = desk()
      d.land([trade(1, 0), through])
      d.frame(hit(1, 20))
      d.frame(hit(3, 30))
      d.land([trade(3, 40, { price: 5050 })])
      expect(d.rows.size).toBe(0)
    })

    test.each([
      ["an NG trade", trade(2, 10, { price: 5075, board: "NG" })],
      [
        "a trade with no side",
        trade(2, 10, { price: 5075, side: "unspecified" }),
      ],
      ["a trade at its price", trade(2, 10)],
    ])("holds through %s", (_name, later) => {
      const d = desk()
      d.land([trade(1, 0), later])
      d.frame(hit(1, 20, big))
      expect(d.rows.get(ORDER)?.closedAt).toBeNull()
    })

    test("holds through a trade numbered before its own", () => {
      const d = desk()
      d.land([trade(1, 0, { price: 5075 }), trade(2, 10)])
      d.frame(hit(2, 20, big))
      expect(d.rows.get(ORDER)?.closedAt).toBeNull()
    })
  })

  describe("an uncrossed maker a trade went through", () => {
    const through = (tradeNumber: number, ms: number) =>
      trade(tradeNumber, ms, { price: 5075 })

    const passed = () => {
      const d = desk()
      d.frame(hit(1, 0))
      d.land([trade(1, 10), trade(2, 20), through(3, 30)])
      return d
    }

    test("a delayed hit still counts, and announces it closed", () => {
      const d = passed()
      expect(d.rows.size).toBe(0)
      const sent = d.frame(hit(2, 40), 8)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({
        hitsSeen: 2,
        lotsMatched: 12,
        closedAt: at(30),
        closedBy: "traded-through",
        seq: 8,
      })
    })

    test("a delayed hit whose trade never lands counts inside the window", () => {
      const d = desk()
      d.frame(hit(1, 0))
      d.frame(hit(2, 10))
      d.land([trade(1, 20), through(3, 30)])
      expect(d.rows.size).toBe(0)
      d.tick(5011)
      expect(d.rows.get(ORDER)).toMatchObject({
        hitsSeen: 2,
        lotsMatched: 12,
        closedBy: "traded-through",
      })
    })

    test("a delayed hit on an order near it joins the same wall", () => {
      const d = passed()
      d.frame(hit(2, 40, { orderNumber: "202610290002329193" }))
      expect(d.rows.get(ORDER)).toMatchObject({
        hitsSeen: 2,
        lotsMatched: 12,
        memberOrderNumbers: [ORDER, "202610290002329193"],
        closedBy: "traded-through",
      })
    })

    describe("a hit numbered past the trade that closed it, with a later through trade held", () => {
      const twice = () => {
        const d = desk()
        d.frame(hit(1, 0))
        d.land([
          trade(1, 10),
          through(2, 20),
          trade(3, 30),
          trade(4, 35),
          through(5, 40),
        ])
        return d
      }

      test("on its order, starts a new maker instead of announcing the old one", () => {
        const d = twice()
        expect(d.frame(hit(3, 50))).toEqual([])
        expect(d.rows.size).toBe(0)

        expect(d.frame(hit(4, 60), 9)[0]).toMatchObject({
          hitsSeen: 2,
          lotsMatched: 12,
          firstSeen: at(50),
          closedAt: at(40),
          closedBy: "traded-through",
          seq: 9,
        })
      })

      test("on an order near it, does not merge", () => {
        const d = twice()
        const near = "202610290002329193"
        expect(d.frame(hit(3, 50, { orderNumber: near }))).toEqual([])
        expect(d.rows.size).toBe(0)
      })
    })

    test("a hit numbered below the closing trade still counts with a later through trade held", () => {
      const d = desk()
      d.frame(hit(1, 0))
      d.land([trade(1, 10), trade(2, 15), through(3, 20), through(4, 30)])
      expect(d.frame(hit(2, 40))[0]).toMatchObject({
        lotsMatched: 12,
        closedAt: at(20),
      })
    })

    test("announced late, it stays gone", () => {
      const d = passed()
      d.frame(hit(2, 40))
      d.frame(hit(4, 50))
      d.land([trade(4, 60)])
      expect(d.rows.get(ORDER)).toMatchObject({
        hitsSeen: 3,
        closedAt: at(30),
        closedBy: "traded-through",
      })
    })

    test("past the join window it is forgotten", () => {
      const d = passed()
      d.tick(5030)
      expect(d.walls.joins.get(BBCA)?.makers).toHaveLength(1)
      d.tick(5031)
      expect(d.walls.joins.has(BBCA)).toBe(false)
    })
  })

  test("a delayed hit does not reopen a wall gone by idle after that hit arrived", () => {
    const d = crossed()
    d.frame(hit(3, 60_000))
    d.tick(60_011)
    d.tick(65_001)
    expect(d.rows.get(ORDER)).toMatchObject({
      hitsSeen: 3,
      closedAt: at(60_011),
      closedBy: "idle",
    })
  })

  test("a delayed hit never moves the wall's last hit back", () => {
    const d = crossed()
    d.frame(hit(3, 100))
    d.frame(hit(4, 200))
    d.land([trade(4, 240)])
    d.tick(5101)
    expect(d.rows.get(ORDER)).toMatchObject({ hitsSeen: 4, lastSeen: at(200) })
    expect(d.tick(60_200)).toEqual([])
    expect(d.tick(60_211)[0]).toMatchObject({ closedBy: "idle" })
  })

  test("a wall traded through stays gone across a restart", () => {
    const d = crossed()
    d.land([trade(9, 100, { price: 5075 })])
    const row = d.rows.get(ORDER)
    if (!row) throw new Error("no wall")
    const walls = createWalls()
    restoreWalls(walls, [row])
    const w = whales()
    feedHit(walls, w, hit(3, 2000), 2)
    const { walls: sent } = feedWallTrades(
      walls,
      w,
      [trade(3, 2040)],
      COVERAGE,
      2
    )
    expect(sent[0]).toMatchObject({
      hitsSeen: 3,
      closedBy: "traded-through",
    })
  })
})

describe("a restart", () => {
  const announced = (): Wall => {
    const row = crossed().rows.get(ORDER)
    if (!row) throw new Error("no wall")
    return row
  }

  test("a restored wall keeps counting on its row", () => {
    const walls = createWalls()
    restoreWalls(walls, [announced()])
    const w = whales()
    feedHit(walls, w, hit(3, 100), 2)
    const { walls: sent } = feedWallTrades(
      walls,
      w,
      [trade(3, 140)],
      COVERAGE,
      2
    )
    expect(sent[0]).toMatchObject({
      firstOrderNumber: ORDER,
      hitsSeen: 3,
      lotsMatched: 18,
      threshold: 10,
    })
  })

  test("a restored wall has lost its counted matches, so a resend counts again", () => {
    const walls = createWalls()
    restoreWalls(walls, [announced()])
    const w = whales()
    feedWallTrades(walls, w, [trade(1, 5140)], COVERAGE, 2)
    const { walls: sent } = feedHit(walls, w, hit(1, 5200), 2)
    expect(sent[0]?.hitsSeen).toBe(3)
  })

  test("a restored wall still goes by trade and by silence", () => {
    const walls = createWalls()
    restoreWalls(walls, [announced()])
    const { walls: sent } = expireWalls(walls, whales(), T0 + 61_000, 2)
    expect(sent[0]?.closedBy).toBe("idle")
  })
})

describe("makerHit", () => {
  const raw = {
    stock: "BBCA",
    date: null,
    prev: null,
    open: null,
    high: null,
    low: null,
    average: null,
    volume: null,
    value: null,
    frequency: null,
    lastprice: 5050,
    verb: "S",
    quantity: 4000,
    orderNumber: ORDER,
    matchNumber: match(1),
  }

  test("the verb is the maker's: S an offer, B a bid, quantity in lots", () => {
    expect(makerHit(BBCA, raw, at(0))).toEqual(hit(1, 0, { lots: 40 }))
    expect(makerHit(BBCA, { ...raw, verb: "B" }, at(0))?.side).toBe("bid")
  })

  test.each(["lastprice", "verb", "quantity", "orderNumber", "matchNumber"])(
    "a frame with no %s is no hit",
    (field) => {
      expect(makerHit(BBCA, { ...raw, [field]: null }, at(0))).toBeNull()
    }
  )

  test("an unknown verb is no hit", () => {
    expect(makerHit(BBCA, { ...raw, verb: "X" }, at(0))).toBeNull()
  })
})
