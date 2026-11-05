import { describe, expect, test } from "vitest"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { MinuteCandle, Sweep } from "@/domain/trade"
import {
  chartMarkers,
  cumulativeNet,
  eventCounts,
  filterEvents,
  netPoints,
  newToasts,
  parseLiveSearch,
  signedLots,
  signedMoney,
  symbolChips,
  whaleEvents,
} from "@/features/radar/live-model"

import { bbcaWall, enrgSweep } from "../../support/whales"

const MINUTE = 60_000
const iso = (s: string) => IsoDateTime.make(s)
const at1 = "2026-10-29T06:42:00.000Z"
const at2 = "2026-10-29T06:43:00.000Z"
const candle = (at: string): MinuteCandle => ({
  at: iso(at),
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  lots: 1,
})
const sweep = (over: Partial<Sweep>): Sweep => ({ ...enrgSweep, ...over })

test("the search takes a symbol, in any case, and nothing else", () => {
  expect(parseLiveSearch({ s: "bmri" }).s).toBe("BMRI")
  expect(parseLiveSearch({ s: "NOPE1" }).s).toBeUndefined()
  expect(parseLiveSearch({}).s).toBeUndefined()
})

describe("whale events", () => {
  const sell = sweep({
    firstNumber: 9,
    side: "sell",
    tradedAt: iso("2026-10-29T06:43:00.000Z"),
    open: true,
    closedBy: null,
  })
  const offer = { ...bbcaWall, side: "offer" as const }
  const bid = { ...bbcaWall, side: "bid" as const, firstOrderNumber: "2" }
  const events = whaleEvents([enrgSweep, sell], [offer, bid])

  test("only the four types, each counted, with All the sum", () => {
    expect(eventCounts(events)).toEqual({
      All: 4,
      "Sweep Buy": 1,
      "Sweep Sell": 1,
      "Bid Wall": 1,
      "Offer Wall": 1,
    })
  })

  test("a filter keeps its own type", () => {
    expect(filterEvents(events, "Bid Wall").map((e) => e.type)).toEqual([
      "Bid Wall",
    ])
    expect(filterEvents(events, "All")).toHaveLength(4)
  })

  test("a sweep's detail says what it took, and a wall's figures are lower bounds", () => {
    const buy = events.find((e) => e.type === "Sweep Buy")
    expect(buy?.detail).toContain(
      "1 aggressive buy order took 198 trades at 665"
    )
    expect(buy?.lots).toBe("48.766")
    const wall = events.find((e) => e.type === "Offer Wall")
    expect(wall?.lots).toMatch(/^≥/)
    expect(wall?.value).toMatch(/^≥/)
    expect(wall?.detail).toContain("≥")
  })
})

describe("net sweep lots", () => {
  const buy = sweep({ lots: 100 })
  const sell = sweep({ firstNumber: 2, side: "sell", lots: 30 })
  const later = sweep({
    firstNumber: 3,
    side: "sell",
    lots: 200,
    tradedAt: iso("2026-10-29T06:43:10.000Z"),
  })

  test("nets per candle and accumulates, quiet candles included", () => {
    expect(
      netPoints(
        [candle(at1), candle(at2), candle("2026-10-29T06:44:00.000Z")],
        [buy, sell, later],
        MINUTE
      ).map(({ net, cumulative }) => [net, cumulative])
    ).toEqual([
      [70, 70],
      [-200, -130],
      [0, -130],
    ])
    expect(cumulativeNet([buy, sell, later])).toBe(-130)
  })

  test("a wall never moves the net", () => {
    expect(netPoints([candle(at1)], [buy], MINUTE)).toEqual(
      netPoints([candle(at1)], [buy], MINUTE)
    )
    const markers = chartMarkers(
      [candle(at1)],
      [],
      [{ ...bbcaWall, firstSeen: iso("2026-10-29T06:42:10.000Z") }],
      MINUTE
    )
    expect(markers.every((m) => m.text.endsWith("Wall"))).toBe(true)
  })

  test("markers name the net side, and skip a level net and an absent candle", () => {
    expect(
      chartMarkers([candle(at1), candle(at2)], [buy, sell, later], [], MINUTE)
    ).toEqual([
      { at: at1, tone: "up", text: "Sweep Buy +70" },
      { at: at2, tone: "down", text: "Sweep Sell -200" },
    ])
    const level = sweep({ firstNumber: 5, side: "sell", lots: 100 })
    expect(chartMarkers([candle(at1)], [buy, level], [], MINUTE)).toEqual([])
    expect(chartMarkers([candle(at2)], [buy], [], MINUTE)).toEqual([])
  })

  test("signed figures always show their sign", () => {
    expect(signedLots(111_500)).toBe("+111,5K")
    expect(signedLots(-86_400)).toBe("-86,4K")
    expect(signedLots(0)).toBe("+0")
    expect(signedMoney(-245_000_000)).toBe("-245M")
    expect(signedMoney(3_240_000_000)).toBe("+3,24B")
  })
})

describe("chips", () => {
  const entry = (symbol: string, buyValue: number, sellValue: number) => ({
    symbol: Symbol.make(symbol),
    buyValue,
    sellValue,
  })

  test("biggest gross first, showing net", () => {
    expect(
      symbolChips([entry("AAAA", 1, 1), entry("BBBB", 1, 9)], null)
    ).toEqual([
      { symbol: "BBBB", net: -8 },
      { symbol: "AAAA", net: 0 },
    ])
  })

  test("the selected symbol is there past the cap, and with no sweeps", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      entry(
        `A${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}A`,
        100 - i,
        0
      )
    )
    const last = many[29]?.symbol ?? null
    expect(symbolChips(many, last).at(-1)?.symbol).toBe(last)
    expect(symbolChips(many, last)).toHaveLength(25)
    expect(symbolChips([], Symbol.make("BMRI"))).toEqual([
      { symbol: "BMRI", net: null },
    ])
  })
})

describe("toasts", () => {
  const now = Date.parse(enrgSweep.updatedAt) + 1000
  const open = sweep({ open: true, closedBy: null })
  const none = { sweeps: [], walls: [] }

  test("a sweep closing, in the operator's names, once", () => {
    const toasts = newToasts(
      { sweeps: [open], walls: [] },
      { sweeps: [enrgSweep], walls: [] },
      now
    )
    expect(toasts).toEqual([
      "ENRG Sweep Buy 48.766 lots (3,24B) at 665, 198 freq · 13:42:35",
    ])
    expect(
      newToasts(
        { sweeps: [enrgSweep], walls: [] },
        { sweeps: [enrgSweep], walls: [] },
        now
      )
    ).toEqual([])
  })

  test("a growing sweep is not news yet", () => {
    expect(newToasts(none, { sweeps: [open], walls: [] }, now)).toEqual([])
  })

  test("a resume's old rows stay quiet", () => {
    expect(
      newToasts(none, { sweeps: [enrgSweep], walls: [] }, now + 60_000)
    ).toEqual([])
  })

  test("a wall's announcement, once", () => {
    const seen = Date.parse(bbcaWall.lastSeen) + 1000
    const after = { sweeps: [], walls: [bbcaWall] }
    expect(newToasts(none, after, seen)[0]).toMatch(/^BBCA (Bid|Offer) Wall ≥/)
    expect(newToasts(after, after, seen)).toEqual([])
  })
})
