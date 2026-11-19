import {
  BrokerCode,
  TradeNumber,
  type Sweep,
  type SweepBroker,
  type SweepPiece,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"

import {
  arrivingNote,
  bubbleRadius,
  bubbleOffset,
  brokerPicks,
  emptyNote,
  keptSweeps,
  largestPiece,
  leadBroker,
  logRows,
  splitSweeps,
  sweepPrice,
  sweepThreshold,
  sweepTip,
  thresholdText,
} from "@/lib/sweeps"
import { cursorLogical } from "@/lib/replay"

// Numbered as the tests make them.
let made = 0
const sweep = (
  wib: string,
  side: Sweep["side"],
  lots: number,
  price = 1000
): Sweep => ({
  side,
  firstTrade: TradeNumber.make(String(++made)),
  time: DateTime.makeUnsafe(`2026-11-09T${wib}+07:00`),
  first: price,
  last: price,
  lots,
  value: price * lots * 100,
  trades: 1,
})

const at = (wib: string) =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(`2026-11-09T${wib}+07:00`))

// The sweeps as the log keeps them with no broker picked.
const unpicked = (sweeps: ReadonlyArray<Sweep>) =>
  Effect.runSync(keptSweeps(sweeps, new Map(), undefined))

// Eight buy sweeps of 10..80 lots and four sell sweeps of 5..20, the last
// sell after 09:30.
const day = unpicked([
  ...[10, 20, 30, 40, 50, 60, 70, 80].map((lots, index) =>
    sweep(`09:0${index}:00`, "buy", lots)
  ),
  sweep("09:01:30", "sell", 5),
  sweep("09:02:30", "sell", 10),
  sweep("09:03:30", "sell", 15),
  sweep("09:31:00", "sell", 20),
  // An auction match never counts.
  sweep("08:58:00", "none", 9_999),
])

describe("the top-N threshold", () => {
  it.effect(
    "is the lower of each side's lot count at its top-N mark, over the sweeps up to the cursor",
    () =>
      Effect.gen(function* () {
        // Buy: ⌈8·25%⌉ = 2nd largest, 70. Sell up to 09:30: ⌈3·25%⌉ = 1st, 15.
        expect(yield* sweepThreshold(day, 25, at("09:30:00"))).toEqual({
          lots: 15,
          buy: 70,
          sell: 15,
        })
        // With 09:31's sell: ⌈4·50%⌉ = 2nd, 15; buy ⌈8·50%⌉ = 4th, 50.
        expect(yield* sweepThreshold(day, 50, at("10:00:00"))).toEqual({
          lots: 15,
          buy: 50,
          sell: 15,
        })
        expect(
          yield* thresholdText(yield* sweepThreshold(day, 25, at("09:30:00")))
        ).toBe("≥ 15 lots (buy 70, sell 15)")
      })
  )

  it.effect("All hides nothing; a side with no sweeps yet doesn't count", () =>
    Effect.gen(function* () {
      expect(yield* sweepThreshold(day, 100, at("10:00:00"))).toEqual({
        lots: 0,
      })
      expect(yield* thresholdText({ lots: 0 })).toBe("")
      expect(yield* sweepThreshold(day, 10, at("09:00:30"))).toEqual({
        lots: 10,
        buy: 10,
      })
      expect(yield* sweepThreshold(day, 10, at("08:59:00"))).toEqual({
        lots: 0,
      })
    })
  )
})

describe("the sweep log", () => {
  it.effect(
    "lists the sweeps up to the cursor newest first, at or above the threshold, big ones only when asked, auction matches always",
    () =>
      Effect.gen(function* () {
        const big = sweep("09:05:30", "buy", 2_000, 5_000)
        // In trade order, as the page holds them.
        const sweeps = [
          day[12]!,
          ...day.slice(0, 8),
          day[8]!,
          ...unpicked([big]),
        ].sort(
          (a, b) =>
            DateTime.toEpochMillis(a.time) - DateTime.toEpochMillis(b.time)
        )
        const rows = yield* logRows(sweeps, {
          threshold: 60,
          bigOnly: false,
          at: at("09:06:00"),
        })
        expect(rows.map((row) => [row.side, row.lots, row.big])).toEqual([
          ["buy", 70, false],
          ["buy", 2_000, true],
          ["buy", 60, false],
          ["none", 9_999, false],
        ])
        const bigRows = yield* logRows(sweeps, {
          threshold: 0,
          bigOnly: true,
          at: at("09:06:00"),
        })
        expect(bigRows.map((row) => row.lots)).toEqual([2_000])
      })
  )
})

describe("bubbles", () => {
  it.effect(
    "sit at the sweep's average price, offset from the minute's centre by its second, with area by lots",
    () =>
      Effect.gen(function* () {
        const walked: Sweep = {
          ...sweep("09:00:00", "buy", 4),
          first: 1000,
          last: 1010,
          value: (1000 * 1 + 1010 * 3) * 100,
        }
        expect(yield* sweepPrice(walked)).toBe(1007.5)
        // Where the cursor line draws its second: the minute's centre plus
        // the fraction of the minute.
        const times = [at("09:00:00") / 1000]
        for (const wib of ["09:00:00", "09:00:50", "09:00:59"])
          expect(yield* bubbleOffset(sweep(`${wib}.400`, "buy", 1), 60)).toBe(
            (yield* cursorLogical(times, at(wib))) * 60
          )
        expect(yield* bubbleOffset(sweep("09:00:50.400", "buy", 1), 60)).toBe(
          50
        )
        expect(yield* bubbleRadius(400)).toBe(5)
        expect(yield* bubbleRadius(1600)).toBe(10)
        expect(yield* bubbleRadius(1)).toBe(1.5)
        expect(yield* bubbleRadius(10_000_000)).toBe(24)
      })
  )
})

const broker = (
  code: string,
  investorType: "D" | "F",
  lots: number
): SweepBroker => ({ code: BrokerCode.make(code), investorType, lots })

// `whole`'s piece of `lots` with `aggressor` its one aggressor.
const piece = (whole: Sweep, lots: number, aggressor: string): SweepPiece => ({
  ...whole,
  lots,
  aggressor: [broker(aggressor, "D", lots)],
  other: [],
})

describe("a side's lead broker", () => {
  it.effect(
    "is the broker with the most lots, the first on a tie, and +N counts the others",
    () =>
      Effect.gen(function* () {
        expect(
          yield* leadBroker([
            broker("BK", "D", 20),
            broker("AK", "F", 120),
            broker("YP", "D", 120),
          ])
        ).toEqual({ code: "AK", investorType: "F", more: 2 })
        expect(yield* leadBroker([broker("CC", "D", 4)])).toEqual({
          code: "CC",
          investorType: "D",
          more: 0,
        })
      })
  )

  it.effect("is none for a side with no brokers", () =>
    Effect.gen(function* () {
      expect(yield* leadBroker([])).toBeUndefined()
    })
  )
})

describe("a sweep's tooltip", () => {
  const buy: Sweep = {
    ...sweep("09:01:02", "buy", 1_240),
    first: 500,
    last: 510,
    trades: 3,
  }
  const sell = sweep("10:15:09", "sell", 7, 2_150)
  const aggressor = [
    broker("AK", "F", 1_000),
    broker("BK", "D", 200),
    broker("YP", "D", 40),
  ]
  const other = [broker("CC", "D", 1_240)]

  it.effect(
    "heads with the side, lots, price path, trade count and time, then lists the aggressor side's brokers before the other side's",
    () =>
      Effect.gen(function* () {
        expect(
          yield* sweepTip(buy, {
            aggressor,
            other,
          })
        ).toEqual({
          title: "Buy 1,240 lots @ 500→510 · 3 trades · 09:01:02",
          sides: [
            { label: "Buyers · aggressor", brokers: aggressor },
            { label: "Sellers", brokers: other },
          ],
        })
      })
  )

  it.effect("names a sell sweep's sellers as its aggressors", () =>
    Effect.gen(function* () {
      const tip = yield* sweepTip(sell, {
        aggressor: other,
        other: aggressor,
      })
      expect(tip.title).toBe("Sell 7 lots @ 2,150 · 1 trade · 10:15:09")
      expect(tip.sides?.map((side) => side.label)).toEqual([
        "Sellers · aggressor",
        "Buyers",
      ])
    })
  )

  it.effect(
    "lists an auction match's buyers and sellers with no aggressor",
    () =>
      Effect.gen(function* () {
        const auction = sweep("08:58:00", "none", 1_240)
        const tip = yield* sweepTip(auction, {
          aggressor,
          other,
        })
        expect(tip.title).toBe(
          "Auction 1,240 lots @ 1,000 · 1 trade · 08:58:00"
        )
        expect(tip.sides).toEqual([
          { label: "Buyers", brokers: aggressor },
          { label: "Sellers", brokers: other },
        ])
      })
  )

  it.effect("lists no brokers for a sweep not yet whole", () =>
    Effect.gen(function* () {
      expect((yield* sweepTip(buy, undefined)).sides).toBeUndefined()
    })
  )
})

describe("the note while a day's codes arrive", () => {
  it.effect(
    "counts the sweeps and auction matches up to the cursor, as grouped before any split, that have their brokers against all of them",
    () =>
      Effect.gen(function* () {
        const sweeps = [
          sweep("08:58:00", "none", 40),
          sweep("09:01:00", "buy", 10),
          sweep("09:02:00", "sell", 20),
          sweep("09:03:00", "buy", 30),
          sweep("09:04:00", "buy", 50),
          sweep("16:00:00", "none", 70),
        ]
        // The 09:03 buy split into two pieces; it counts once.
        const entries = new Map(
          [sweeps[0]!, sweeps[1]!, sweeps[3]!, sweeps[4]!].map((whole) => [
            whole.firstTrade,
            {
              firstTrade: whole.firstTrade,
              pieces:
                whole === sweeps[3]
                  ? [piece(whole, 20, "AK"), piece(whole, 10, "BK")]
                  : [piece(whole, whole.lots, "AK")],
            },
          ])
        )
        expect(yield* arrivingNote(sweeps, entries, at("09:03:30"), true)).toBe(
          "Codes still arriving: 3 of 4 sweeps have their brokers. Updates every 30 s."
        )
        expect(yield* arrivingNote(sweeps, entries, at("16:30:00"), true)).toBe(
          "Codes still arriving: 4 of 6 sweeps have their brokers. Updates every 30 s."
        )
      })
  )

  // A cold day takes no more codes, so the page asks no more.
  it.effect(
    "says the codes stay incomplete, with no update, once the page asks no more",
    () =>
      Effect.gen(function* () {
        const sweeps = [
          sweep("09:01:00", "buy", 10),
          sweep("09:02:00", "sell", 20),
        ]
        const entries = new Map([
          [
            sweeps[0]!.firstTrade,
            {
              firstTrade: sweeps[0]!.firstTrade,
              pieces: [piece(sweeps[0]!, 10, "AK")],
            },
          ],
        ])
        expect(
          yield* arrivingNote(sweeps, entries, at("16:30:00"), false)
        ).toBe("Codes incomplete: 1 of 2 sweeps have their brokers.")
      })
  )
})

describe("the broker filter", () => {
  const ak = BrokerCode.make("AK")
  const whole = (
    of: Sweep,
    aggressor: ReadonlyArray<SweepBroker>,
    other: ReadonlyArray<SweepBroker> = []
  ) => [of.firstTrade, { aggressor, other }] as const
  const sweeps = [
    sweep("09:00:00", "buy", 500),
    sweep("09:01:00", "buy", 300),
    sweep("09:02:00", "buy", 100),
    sweep("09:03:00", "sell", 200),
    sweep("09:04:00", "none", 900),
    sweep("09:05:00", "buy", 90),
    sweep("09:06:00", "sell", 60),
    sweep("09:07:00", "sell", 1_000),
    // After the cursor.
    sweep("09:30:00", "sell", 5_000),
  ]
  // Each sided sweep is a piece with one aggressor. The 09:03 sell is not
  // whole yet, so it has no brokers.
  const brokers = new Map([
    whole(sweeps[0]!, [broker("AK", "F", 500)]),
    whole(sweeps[1]!, [broker("YP", "D", 300)]),
    // AK only sold into the third buy: the other side.
    whole(sweeps[2]!, [broker("BK", "D", 100)], [broker("AK", "F", 100)]),
    // The auction match: AK bought 300 and sold 500 of its 900 lots.
    whole(
      sweeps[4]!,
      [broker("CC", "D", 600), broker("AK", "F", 300)],
      [broker("AK", "F", 500), broker("YP", "D", 400)]
    ),
    whole(sweeps[5]!, [broker("AK", "F", 90)]),
    whole(sweeps[6]!, [broker("AK", "F", 60)]),
    whole(sweeps[7]!, [broker("CC", "D", 1_000)]),
    whole(sweeps[8]!, [broker("AK", "F", 5_000)]),
  ])

  it.effect(
    "keeps the pieces whose aggressor is the picked broker at their whole lots, and an auction match it bought or sold in at the larger of the two",
    () =>
      Effect.gen(function* () {
        const kept = yield* keptSweeps(sweeps, brokers, ak)
        expect(kept.map((row) => [row.lots, row.own])).toEqual([
          [500, 500],
          [900, 500],
          [90, 90],
          [60, 60],
          [5_000, 5_000],
        ])
      })
  )

  it.effect(
    "keeps every sweep and auction match at its whole lots with no broker picked",
    () =>
      Effect.gen(function* () {
        const kept = yield* keptSweeps(sweeps.slice(0, 5), brokers, undefined)
        expect(kept.map((row) => [row.lots, row.own])).toEqual([
          [500, 500],
          [300, 300],
          [100, 100],
          [200, 200],
          [900, 900],
        ])
      })
  )

  it.effect(
    "lists the aggressor brokers up to the cursor, largest summed aggressor lots first",
    () =>
      Effect.gen(function* () {
        // AK: 500 + 90 + 60; its 5,000 is after the cursor, its 100 on the
        // third buy's other side, and an auction match's buyers are no
        // aggressors: CC's 600 and AK's 300 there don't count.
        expect(yield* brokerPicks(sweeps, brokers, at("09:10:00"))).toEqual([
          { code: "CC", investorType: "D", lots: 1_000 },
          { code: "AK", investorType: "F", lots: 650 },
          { code: "YP", investorType: "D", lots: 300 },
          { code: "BK", investorType: "D", lots: 100 },
        ])
        expect(yield* brokerPicks(sweeps, brokers, at("08:00:00"))).toEqual([])
      })
  )

  it.effect(
    "lists a broker at the investor type of its larger summed aggressor lots, the first on a tie",
    () =>
      Effect.gen(function* () {
        const five = [
          sweep("09:00:00", "buy", 40),
          sweep("09:01:00", "buy", 30),
          sweep("09:02:00", "buy", 60),
          sweep("09:03:00", "buy", 70),
          sweep("09:04:00", "sell", 50),
        ]
        const typed = new Map([
          whole(five[0]!, [broker("AK", "F", 40)]),
          whole(five[1]!, [broker("BK", "D", 30)]),
          whole(five[2]!, [broker("AK", "D", 60)]),
          whole(five[3]!, [broker("BK", "F", 70)]),
          whole(five[4]!, [broker("AK", "F", 50)]),
        ])
        // AK: F 90 against D 60. BK: F 70 against D 30, though its first
        // sweep was D.
        expect(yield* brokerPicks(five, typed, at("09:10:00"))).toEqual([
          { code: "AK", investorType: "F", lots: 150 },
          { code: "BK", investorType: "F", lots: 100 },
        ])
        // Up to 09:02, AK's D 60 is the larger.
        expect(yield* brokerPicks(five, typed, at("09:02:30"))).toEqual([
          { code: "AK", investorType: "D", lots: 100 },
          { code: "BK", investorType: "D", lots: 30 },
        ])
        // A tie keeps the first type.
        const tied = new Map([
          whole(five[0]!, [broker("AK", "F", 40)]),
          whole(five[2]!, [broker("AK", "D", 40)]),
        ])
        expect(yield* brokerPicks(five, tied, at("09:10:00"))).toEqual([
          { code: "AK", investorType: "F", lots: 80 },
        ])
      })
  )

  it.effect(
    "cuts each side at its top-N mark of the picked broker's own lots, over its sweeps up to the cursor, and names the broker",
    () =>
      Effect.gen(function* () {
        const kept = yield* keptSweeps(sweeps, brokers, ak)
        // Buy: AK's 500 and 90; ⌈2·50%⌉ = 1st, 500. Sell up to 09:10: AK's
        // 60; ⌈1·50%⌉ = 1st, 60. All the sweeps' lots would cut at 300 and
        // 1,000.
        const threshold = yield* sweepThreshold(kept, 50, at("09:10:00"))
        expect(threshold).toEqual({ lots: 60, buy: 500, sell: 60 })
        expect(yield* thresholdText(threshold, ak)).toBe(
          "≥ 60 lots of AK (buy 500, sell 60)"
        )
        // The log shows a sweep by its own lots too, and never hides the
        // auction match.
        const rows = yield* logRows(kept, {
          threshold: threshold.lots,
          bigOnly: false,
          at: at("09:10:00"),
        })
        expect(rows.map((row) => [row.lots, row.own])).toEqual([
          [60, 60],
          [90, 90],
          [900, 500],
          [500, 500],
        ])
      })
  )

  it.effect(
    "says the picked broker was in no sweep only when it has no kept sweep up to the cursor",
    () =>
      Effect.gen(function* () {
        const kept = yield* keptSweeps(sweeps, brokers, ak)
        // Before AK's first sweep.
        expect(yield* emptyNote(kept, ak, at("08:00:00"))).toBe(
          "No sweeps where AK was an aggressor."
        )
        // AK has sweeps the top-N or Big only may hide: no note of its own.
        expect(yield* emptyNote(kept, ak, at("09:10:00"))).toBeUndefined()
        expect(yield* emptyNote(day, undefined, at("08:00:00"))).toBeUndefined()
      })
  )
})

describe("a whole sweep's split", () => {
  // UNTR's 09:01:02 sell of FZ 10, XL 4 and FZ 6 lots, trades 1–3, between
  // a buy not yet whole and an auction match.
  const fz = (lots: number) => [broker("FZ", "D", lots)]
  const before = sweep("09:01:01", "buy", 7)
  const sell: Sweep = { ...sweep("09:01:02", "sell", 20), trades: 3 }
  const match = sweep("09:01:03", "none", 9)
  const fzPiece: SweepPiece = {
    ...sell,
    lots: 16,
    value: 1_600_000,
    trades: 2,
    aggressor: fz(16),
    other: [broker("AK", "F", 16)],
  }
  const xlPiece: SweepPiece = {
    ...sell,
    firstTrade: TradeNumber.make("9002"),
    time: DateTime.makeUnsafe("2026-11-09T09:01:02.300+07:00"),
    lots: 4,
    value: 400_000,
    trades: 1,
    aggressor: [broker("XL", "D", 4)],
    other: [broker("CC", "D", 4), broker("YP", "D", 0)],
  }
  const entries = new Map([
    [
      sell.firstTrade,
      { firstTrade: sell.firstTrade, pieces: [fzPiece, xlPiece] },
    ],
    [
      match.firstTrade,
      { firstTrade: match.firstTrade, pieces: [piece(match, 9, "AK")] },
    ],
  ])

  it.effect(
    "swaps a whole sweep for its pieces in trade order, and keeps a sweep not yet whole",
    () =>
      Effect.gen(function* () {
        const split = yield* splitSweeps([before, sell, match], entries)
        expect(
          split.sweeps.map((shown) => [shown.firstTrade, shown.lots])
        ).toEqual([
          [before.firstTrade, 7],
          [sell.firstTrade, 16],
          [xlPiece.firstTrade, 4],
          [match.firstTrade, 9],
        ])
        expect([...split.pieces.keys()]).toEqual([
          sell.firstTrade,
          xlPiece.firstTrade,
          match.firstTrade,
        ])
        // A piece's Aggressor cell names its one broker with no +N.
        const lead = yield* leadBroker(
          split.pieces.get(xlPiece.firstTrade)!.aggressor
        )
        expect(lead).toEqual({ code: "XL", investorType: "D", more: 0 })
      })
  )

  it.effect(
    "moves a pin to the largest piece, the first in trade order on a tie",
    () =>
      Effect.gen(function* () {
        expect(yield* largestPiece(entries.get(sell.firstTrade)!)).toBe(
          sell.firstTrade
        )
        const tied = {
          firstTrade: sell.firstTrade,
          pieces: [
            { ...fzPiece, lots: 4 },
            { ...xlPiece, lots: 10 },
            { ...xlPiece, firstTrade: TradeNumber.make("99"), lots: 10 },
          ],
        }
        expect(yield* largestPiece(tied)).toBe(xlPiece.firstTrade)
      })
  )

  it.effect("keeps a piece for its aggressor only", () =>
    Effect.gen(function* () {
      const split = yield* splitSweeps([before, sell, match], entries)
      const xl = BrokerCode.make("XL")
      const kept = yield* keptSweeps(split.sweeps, split.pieces, xl)
      expect(kept.map((row) => [row.firstTrade, row.own])).toEqual([
        [xlPiece.firstTrade, 4],
      ])
      // CC only bought from it.
      expect(
        yield* keptSweeps(split.sweeps, split.pieces, BrokerCode.make("CC"))
      ).toEqual([])
    })
  )
})
