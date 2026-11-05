import { expect, test } from "vitest"

import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { LiveSymbol, Trade } from "@/domain/trade"
import { emptyDemoTape } from "@/features/radar/demo-tape"
import { EMPTY_WHALES_TODAY } from "@/features/radar/data"
import { LiveRadarPage } from "@/features/radar/live-page"
import { NO_CANDLES } from "@/relay/candles"

import { renderAt } from "../../support/render-at"
import { bbcaWall, enrgSweep } from "../../support/whales"

const ENRG = Symbol.make("ENRG")

const render = (over: Parameters<typeof LiveRadarPage>[0]) =>
  renderAt("/radar/live", () => <LiveRadarPage {...over} />)

test("an empty day says so, and offers no fake figures", async () => {
  const html = await render({
    today: EMPTY_WHALES_TODAY,
    symbol: null,
    live: null,
  })
  expect(html).toContain("No sweeps this session yet")
  expect(html).toContain("Whale Radar Live")
  expect(html).not.toContain("Sweep Buy")
})

test("a symbol shows its filter counts, feed, chip, and only the four types", async () => {
  const html = await render({
    today: {
      ...EMPTY_WHALES_TODAY,
      day: "2026-10-29",
      leaderboard: [{ symbol: ENRG, buyValue: 3_240_000_000, sellValue: 0 }],
    },
    symbol: ENRG,
    live: {
      backfill: {
        ...emptyDemoTape(ENRG),
        day: "2026-10-29",
        sweeps: [enrgSweep],
        walls: [{ ...bbcaWall, symbol: ENRG, side: "offer" }],
        wallCoverage: true,
      },
      candles: NO_CANDLES,
    },
  })
  for (const label of [
    "All",
    "Sweep Buy",
    "Sweep Sell",
    "Bid Wall",
    "Offer Wall",
  ])
    expect(html).toContain(label)
  expect(html).toContain("1 aggressive buy order took 198 trades at 665")
  expect(html).toContain("+3,24B")
  expect(html).toContain("Last session · 2026-10-29")
  expect(html).toMatch(/aria-current="true"/)
  expect(html).not.toContain("Walls not watched")
  for (const gone of ["SAPU", "BLOK", "SERANGAN", "PECAH", "NEGO"])
    expect(html).not.toContain(gone)
})

test("a symbol outside the wall coverage says so, never an empty list", async () => {
  const html = await render({
    today: EMPTY_WHALES_TODAY,
    symbol: ENRG,
    live: { backfill: emptyDemoTape(ENRG), candles: NO_CANDLES },
  })
  expect(html).toContain("Walls not watched")
  expect(html).toContain("No regular-board trades on ENRG")
})

const NSSS = Symbol.make("NSSS")

const nsss = (
  tradeNumber: number,
  board: string,
  at: string,
  price = 455
): Trade => ({
  symbol: NSSS,
  price,
  volume: 50_000_000,
  value: price * 50_000_000,
  side: board === "RG" ? "buy" : "unspecified",
  board,
  tradeNumber,
  tradedAt: IsoDateTime.make(at),
  receivedAt: IsoDateTime.make(at),
  change: 0,
})

const offBoardTrade = nsss(3, "NG", "2026-11-04T03:42:00Z")
const earlier = nsss(1, "NG", "2026-11-04T03:25:00Z")
const regular = nsss(4, "RG", "2026-11-04T03:43:00Z", 450)

const nsssLive = (
  trades: Array<Trade>,
  offBoard: Array<Trade>,
  candles = NO_CANDLES
): LiveSymbol => ({
  backfill: { ...emptyDemoTape(NSSS), day: "2026-11-04", trades, offBoard },
  candles,
})

test("the off-board list shows the session's off-board trades, newest first, with a count", async () => {
  const html = await render({
    today: EMPTY_WHALES_TODAY,
    symbol: NSSS,
    live: nsssLive([regular, offBoardTrade], [offBoardTrade, earlier]),
  })
  const list = html.slice(html.indexOf('aria-label="Off-board trades"'))
  expect(list).toContain("Off-board · 2")
  for (const cell of ["10:42:00", "NG", "455", "500.000", "22,75B"])
    expect(list).toContain(cell)
  expect(list.indexOf("10:42:00")).toBeLessThan(list.indexOf("10:25:00"))
})

test("with no off-board trades, the list says so quietly", async () => {
  const html = await render({
    today: EMPTY_WHALES_TODAY,
    symbol: NSSS,
    live: nsssLive([regular], []),
  })
  expect(html).toContain("Off-board · 0")
  expect(html).toContain("No off-board trades this session")
})

test("the raw tape is collapsed, the newest 200 from every board, flagged only by board", async () => {
  const html = await render({
    today: EMPTY_WHALES_TODAY,
    symbol: NSSS,
    live: nsssLive([regular, offBoardTrade], [offBoardTrade]),
  })
  const raw = html.slice(html.indexOf("<details"))
  expect(raw.slice(0, raw.indexOf(">"))).not.toContain("open")
  expect(raw).toContain("Raw tape · newest 200 trades")
  for (const column of ["Time", "Board", "Side", "Price", "Lots", "Value"])
    expect(raw).toContain(column)
  expect(raw).toContain("10:43:00")
  expect(raw).toContain("10:42:00")
})

test("volume reads regular board only, and an off-board-only symbol points at its list", async () => {
  const html = await render({
    today: EMPTY_WHALES_TODAY,
    symbol: NSSS,
    live: nsssLive([offBoardTrade, earlier], [offBoardTrade, earlier]),
  })
  expect(html).toContain("No regular-board trades on NSSS this session")
  expect(html).toContain("2 off-board trades are listed below.")
  expect(html).toContain("Volume is regular board only")
})
