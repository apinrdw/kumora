import { describe, expect, test } from "vitest"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { Trade } from "@/domain/trade"
import {
  closeIdle,
  createWhales,
  feedTrades,
  sketchOf,
  thresholdOf,
} from "@/relay/whale"
import { dedupe } from "@/relay/tape"

const BBCA = Symbol.make("BBCA")
const TLKM = Symbol.make("TLKM")
const AT = IsoDateTime.make("2026-10-29T03:00:00.000Z")
const LATER = IsoDateTime.make("2026-10-29T03:00:00.500Z")
const T0 = Date.parse(AT)

type Over = Partial<Trade> & { tradeNumber: number; lots?: number; at?: number }

/** A trade of `lots` lots, received `at` ms after the start. */
const trade = ({ lots = 10, at = 0, ...over }: Over): Trade => ({
  symbol: BBCA,
  price: 100,
  volume: lots * 100,
  value: lots * 100 * (over.price ?? 100),
  side: "buy",
  board: "RG",
  tradedAt: AT,
  receivedAt: IsoDateTime.make(new Date(T0 + at).toISOString()),
  change: 0,
  ...over,
})

/** Closes `count` orders of `lots` lots on BBCA, so the sketch holds them. */
const settle = (
  whales: ReturnType<typeof createWhales>,
  lots: number,
  count = 1
) => {
  for (let i = 0; i < count; i++)
    feedTrades(
      whales,
      [
        trade({
          tradeNumber: 1 + i,
          lots,
          tradedAt: IsoDateTime.make(new Date(T0 - 100_000 + i).toISOString()),
        }),
      ],
      1
    )
  closeIdle(whales, T0 + 1000, 1)
}

const orders =
  (symbol = BBCA) =>
  (w: ReturnType<typeof createWhales>) =>
    thresholdOf(w, symbol, AT).ordersToday

describe("the threshold", () => {
  test("with no prior and no orders it is null and nothing flags", () => {
    const whales = createWhales()

    const changes = feedTrades(
      whales,
      [trade({ tradeNumber: 1, lots: 1_000_000 })],
      1
    )

    expect(changes.sweeps).toEqual([])
    expect(thresholdOf(createWhales(), BBCA, AT)).toEqual({
      symbol: BBCA,
      threshold: null,
      warmingUp: true,
      prior: "none",
      ordersToday: 0,
      asOf: AT,
    })
  })

  test("reading a symbol never seen creates nothing", () => {
    const whales = createWhales()
    thresholdOf(whales, BBCA, AT)
    expect(whales.sketches.size).toBe(0)
  })

  test("falls from the symbol's own prior to the market's to none", () => {
    const own = sketchOf(Array.from({ length: 100 }, () => 20))
    const market = sketchOf(Array.from({ length: 100 }, () => 500))
    const whales = createWhales({ own: new Map([[BBCA, own]]), market })

    expect(thresholdOf(whales, BBCA, AT)).toMatchObject({
      threshold: 20,
      prior: "own",
    })
    expect(thresholdOf(whales, TLKM, AT).prior).toBe("market")
    expect(thresholdOf(createWhales(), BBCA, AT).prior).toBe("none")
  })

  test("an empty market sketch counts as no prior", () => {
    const whales = createWhales({ own: new Map(), market: sketchOf([]) })
    expect(thresholdOf(whales, BBCA, AT)).toMatchObject({
      threshold: null,
      prior: "none",
    })
  })

  test.each([
    [999, true],
    [1000, false],
  ])("after %i orders warmingUp is %s, whatever the prior", (count, warm) => {
    const own = sketchOf([5])
    const whales = createWhales({ own: new Map([[BBCA, own]]), market: null })
    settle(whales, 3, count)
    expect(thresholdOf(whales, BBCA, AT)).toMatchObject({
      warmingUp: warm,
      ordersToday: count,
    })
  })

  test("with integer counts it is the nearest rank of today's orders", () => {
    const whales = createWhales()
    // 99 orders of 10 and one of 40: rank 99 of 100 is a 10.
    settle(whales, 10, 99)
    feedTrades(
      whales,
      [trade({ tradeNumber: 500, lots: 40, tradedAt: LATER })],
      1
    )
    closeIdle(whales, T0 + 5000, 1)
    expect(thresholdOf(whales, BBCA, AT).threshold).toBe(10)
  })

  test("a fractional prior does not skip a rank", () => {
    const prior = [...Array.from({ length: 299 }, () => 10), 100]
    const own = sketchOf(prior)
    const whales = createWhales({ own: new Map([[BBCA, own]]), market: null })
    settle(whales, 10, 43)
    settle(whales, 100, 7)
    // Weight 1000/300. The 10s hold 996.67 + 43 = 1039.67 against a target of
    // 0.99 × 1050 = 1039.5, so they reach it. A `ceil` of the target, 1040, would not.
    expect(thresholdOf(whales, BBCA, AT).threshold).toBe(10)
  })

  test("is read before the order's first trade and kept for its life", () => {
    const whales = createWhales()
    settle(whales, 10)

    const { sweeps } = feedTrades(
      whales,
      [trade({ tradeNumber: 50, lots: 11, tradedAt: LATER })],
      2
    )
    expect(sweeps[0]?.threshold).toBe(10)

    closeIdle(whales, T0 + 5000, 2)
    expect(thresholdOf(whales, BBCA, AT).threshold).toBe(11)
  })
})

describe("orders", () => {
  test("an order straddling two batches is one sweep", () => {
    const whales = createWhales()
    settle(whales, 10)

    const first = feedTrades(
      whales,
      [trade({ tradeNumber: 50, lots: 6, tradedAt: LATER })],
      2
    )
    expect(first.sweeps).toEqual([])

    const second = feedTrades(
      whales,
      [
        trade({
          tradeNumber: 51,
          lots: 6,
          tradedAt: LATER,
          price: 110,
          at: 100,
        }),
      ],
      3
    )
    expect(second.sweeps).toEqual([
      expect.objectContaining({
        firstNumber: 50,
        lastNumber: 51,
        lots: 12,
        freq: 2,
        priceLow: 100,
        priceHigh: 110,
        open: true,
        closedBy: null,
        seq: 3,
        day: "2026-10-29",
      }),
    ])
  })

  test("a range is low to high, not first to last", () => {
    const whales = createWhales()
    settle(whales, 1)
    const { sweeps } = feedTrades(
      whales,
      [
        trade({ tradeNumber: 50, tradedAt: LATER, price: 110 }),
        trade({ tradeNumber: 51, tradedAt: LATER, price: 100 }),
        trade({ tradeNumber: 52, tradedAt: LATER, price: 105 }),
      ],
      2
    )
    expect(sweeps[0]).toMatchObject({ priceLow: 100, priceHigh: 110 })
  })

  test("a tie flags", () => {
    const whales = createWhales()
    settle(whales, 10)
    const { sweeps } = feedTrades(
      whales,
      [trade({ tradeNumber: 50, lots: 10, tradedAt: LATER })],
      2
    )
    expect(sweeps).toHaveLength(1)
  })

  test("one lot under does not flag", () => {
    const whales = createWhales()
    settle(whales, 10)
    const { sweeps } = feedTrades(
      whales,
      [trade({ tradeNumber: 50, lots: 9, tradedAt: LATER })],
      2
    )
    expect(sweeps).toEqual([])
  })

  test("a growing sweep reports its last state once per batch", () => {
    const whales = createWhales()
    settle(whales, 1)
    const { sweeps } = feedTrades(
      whales,
      [
        trade({ tradeNumber: 50, tradedAt: LATER }),
        trade({ tradeNumber: 51, tradedAt: LATER }),
      ],
      2
    )
    expect(sweeps.map((s) => s.freq)).toEqual([2])
  })

  test("the first announcement's instant survives growth", () => {
    const whales = createWhales()
    settle(whales, 1)
    feedTrades(whales, [trade({ tradeNumber: 50, tradedAt: LATER })], 2)
    const { sweeps } = feedTrades(
      whales,
      [trade({ tradeNumber: 51, tradedAt: LATER, at: 100 })],
      3
    )
    expect(sweeps[0]).toMatchObject({
      announcedAt: AT,
      updatedAt: "2026-10-29T03:00:00.100Z",
    })
  })

  test.each([
    ["side", { side: "sell" } as const],
    ["millisecond", { tradedAt: IsoDateTime.make("2026-10-29T03:00:00.501Z") }],
  ])("a different %s closes it as next-order", (_, over) => {
    const whales = createWhales()
    settle(whales, 1)
    const { sweeps } = feedTrades(
      whales,
      [
        trade({ tradeNumber: 50, tradedAt: LATER, lots: 5 }),
        trade({ tradeNumber: 51, tradedAt: LATER, lots: 1, ...over }),
      ],
      2
    )
    expect(sweeps.find((s) => s.firstNumber === 50)).toMatchObject({
      open: false,
      closedBy: "next-order",
      lots: 5,
    })
  })

  test("500 ms without a trade does not close it, and 501 does", () => {
    const whales = createWhales()
    settle(whales, 1)
    feedTrades(whales, [trade({ tradeNumber: 50, tradedAt: LATER })], 2)

    expect(closeIdle(whales, T0 + 500, 2).sweeps).toEqual([])
    expect(closeIdle(whales, T0 + 501, 3).sweeps).toEqual([
      expect.objectContaining({ open: false, closedBy: "idle", seq: 3 }),
    ])
    expect(closeIdle(whales, T0 + 9000, 4).sweeps).toEqual([])
  })

  describe("a fresh trade after a gap", () => {
    /** A symbol whose threshold is 10 lots. */
    const tenLots = () =>
      createWhales({ own: new Map([[BBCA, sketchOf([10])]]), market: null })

    test("past 500 ms the order closes as idle and the trade opens a new one", () => {
      const whales = tenLots()
      feedTrades(whales, [trade({ tradeNumber: 1, lots: 6 })], 1)

      const { sweeps } = feedTrades(
        whales,
        [trade({ tradeNumber: 2, lots: 6, at: 501 })],
        2
      )

      expect(sweeps).toEqual([])
      expect(whales.open.get(BBCA)?.firstNumber).toBe(2)
      expect(orders()(whales)).toBe(1)
    })

    test("at 500 ms a batch boundary still extends the order", () => {
      const whales = tenLots()
      feedTrades(whales, [trade({ tradeNumber: 1, lots: 6 })], 1)

      const { sweeps } = feedTrades(
        whales,
        [trade({ tradeNumber: 2, lots: 6, at: 500 })],
        2
      )

      expect(sweeps).toEqual([
        expect.objectContaining({ firstNumber: 1, lots: 12, open: true }),
      ])
      expect(orders()(whales)).toBe(0)
    })

    test("past 500 ms an announced sweep's row closes as idle at that trade", () => {
      const whales = tenLots()
      feedTrades(whales, [trade({ tradeNumber: 1, lots: 12 })], 1)

      const { sweeps } = feedTrades(
        whales,
        [trade({ tradeNumber: 2, lots: 12, at: 501 })],
        2
      )

      expect(sweeps).toEqual([
        expect.objectContaining({
          firstNumber: 1,
          lots: 12,
          closedBy: "idle",
          updatedAt: IsoDateTime.make(new Date(T0 + 501).toISOString()),
        }),
        expect.objectContaining({ firstNumber: 2, lots: 12, open: true }),
      ])
    })

    test("past 500 ms a trade of the other side finds the order already idle", () => {
      const whales = tenLots()
      feedTrades(whales, [trade({ tradeNumber: 1, lots: 12 })], 1)

      const { sweeps } = feedTrades(
        whales,
        [trade({ tradeNumber: 2, side: "sell", at: 501 })],
        2
      )

      expect(sweeps[0]).toMatchObject({ firstNumber: 1, closedBy: "idle" })
    })
  })

  test.each([
    ["TN", { board: "TN" }],
    ["NG", { board: "NG" }],
    ["unspecified", { side: "unspecified" } as const],
  ])("%s leaves an open order and the sketch alone", (_, over) => {
    const whales = createWhales()
    settle(whales, 1)
    feedTrades(whales, [trade({ tradeNumber: 50, tradedAt: LATER })], 2)
    const before = thresholdOf(whales, BBCA, AT)

    const { sweeps } = feedTrades(
      whales,
      [
        trade({
          tradeNumber: 51,
          lots: 1_000_000,
          tradedAt: IsoDateTime.make("2026-10-29T03:00:09.000Z"),
          ...over,
        }),
      ],
      3
    )
    expect(sweeps).toEqual([])

    const closed = closeIdle(whales, T0 + 501, 3).sweeps
    expect(closed).toEqual([
      expect.objectContaining({ firstNumber: 50, lastNumber: 50, freq: 1 }),
    ])
    expect(orders()(whales)).toBe(before.ordersToday + 1)
  })

  test("an order enters the sketch once, when it closes", () => {
    const whales = createWhales()
    feedTrades(whales, [trade({ tradeNumber: 1 })], 1)
    feedTrades(whales, [trade({ tradeNumber: 2 })], 2)
    expect(orders()(whales)).toBe(0)

    closeIdle(whales, T0 + 1000, 2)
    expect(orders()(whales)).toBe(1)
  })
})

describe("Stockbit's resend", () => {
  test("after the relay's dedupe, a full resend adds nothing", () => {
    const whales = createWhales()
    settle(whales, 1)
    const last = new Map<Symbol, number>()
    const batch = [
      trade({ tradeNumber: 50, tradedAt: LATER, lots: 5 }),
      trade({ tradeNumber: 51, tradedAt: LATER, lots: 5 }),
    ]
    expect(feedTrades(whales, dedupe(last, batch), 2).sweeps).toHaveLength(1)
    closeIdle(whales, T0 + 1000, 2)
    const before = thresholdOf(whales, BBCA, AT)

    const again = feedTrades(whales, dedupe(last, batch), 3)

    expect(again.sweeps).toEqual([])
    expect(closeIdle(whales, T0 + 5000, 3).sweeps).toEqual([])
    expect(thresholdOf(whales, BBCA, AT)).toEqual(before)
  })
})

describe("what the rebuild needs", () => {
  test("a closed order marks its symbol dirty and its last trade number", () => {
    const whales = createWhales()
    feedTrades(
      whales,
      [trade({ tradeNumber: 7 }), trade({ tradeNumber: 8 })],
      1
    )
    expect(whales.dirty.size).toBe(0)

    closeIdle(whales, T0 + 1000, 1)
    expect([...whales.dirty]).toEqual([BBCA])
    expect(whales.sketches.get(BBCA)?.lastNumber).toBe(8)
  })

  test("an open order remembers the seq of its first trade", () => {
    const whales = createWhales()
    feedTrades(whales, [trade({ tradeNumber: 1 })], 5)
    feedTrades(whales, [trade({ tradeNumber: 2, at: 100 })], 6)
    expect(whales.open.get(BBCA)?.firstSeq).toBe(5)
  })
})
