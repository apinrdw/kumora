import { describe, expect, test } from "vitest"

import { renderAt } from "../../support/render-at"
import { bbcaWall, enrgSweep } from "../../support/whales"
import { Symbol } from "@/domain/symbol"
import type { WhalesToday } from "@/domain/trade"
import { sweepLine } from "@/features/radar/whale-format"
import { RADAR_SNAPSHOT } from "@/features/radar/data"
import { RadarPage } from "@/features/radar/radar-page"

const render = (search = "") =>
  renderAt(`/radar${search}`, () => <RadarPage snapshot={RADAR_SNAPSHOT} />)

/** The ticker the evidence drawer is showing, read from its "Buka detail" link. */
const drawerTicker = (html: string) => {
  const drawer = html.slice(html.indexOf('aria-label="Bukti kandidat"'))
  return drawer.match(/href="\/radar\/live\?s=([A-Z]+)"/)?.[1]
}

const withWhales = (whales: Partial<WhalesToday>) =>
  renderAt("/radar", () => (
    <RadarPage
      snapshot={{
        ...RADAR_SNAPSHOT,
        whales: { ...RADAR_SNAPSHOT.whales, ...whales },
      }}
    />
  ))

/** What sits between the page's title and the candidates. */
const feed = (html: string) => {
  const start = html.indexOf('aria-label="Sweep feed"')
  return html.slice(start, html.indexOf('aria-label="Daftar kandidat"', start))
}

describe("the sweep feed", () => {
  test("an empty morning says so, above the candidates, which stay on demo", async () => {
    const html = await render()
    const panel = feed(html)
    expect(panel).toContain("Belum ada sweep hari ini")
    expect(panel).toContain("Thresholds on 0 symbols, 0 still warming up")
    expect(panel).toMatch(/>0 sweeps · 0 walls</)
    expect(panel).not.toContain("Most swept today")
    expect(html.indexOf('aria-label="Sweep feed"')).toBeLessThan(
      html.indexOf('aria-label="Daftar kandidat"')
    )
    expect(html).toContain("DATA DEMO")
    expect(html).toMatch(/>6 kandidat · per /)
  })

  test("shows the agreed line, tinted by side, with the warming tag", async () => {
    const panel = feed(
      await withWhales({
        sweeps: [
          enrgSweep,
          {
            ...enrgSweep,
            firstNumber: 9,
            side: "sell",
            warmingUp: false,
            open: true,
          },
        ],
        sweepsTotal: 2,
      })
    )
    expect(panel).toContain(
      "13:42:35  ENRG  RG  Sweep buy  48.766 at 665  3,24B  198 freq"
    )
    expect(panel).not.toContain("Belum ada sweep")
    expect(panel).toMatch(/>2 sweeps · 0 walls</)
    expect(panel.match(/text-up/g)).toHaveLength(1)
    expect(panel.match(/text-down/g)).toHaveLength(1)
    expect(panel.match(/>warming</g)).toHaveLength(1)
  })

  test("most swept lists the totals with buy and sell bars to one scale", async () => {
    const panel = feed(
      await withWhales({
        sweeps: [enrgSweep],
        sweepsTotal: 1,
        leaderboard: [
          {
            symbol: enrgSweep.symbol,
            buyValue: 3_000_000_000,
            sellValue: 1_000_000_000,
          },
          {
            symbol: Symbol.make("BBCA"),
            buyValue: 0,
            sellValue: 2_000_000_000,
          },
        ],
      })
    )
    const board = panel.slice(panel.indexOf("Most swept today, by value"))
    expect(board.indexOf(">ENRG<")).toBeLessThan(board.indexOf(">BBCA<"))
    expect(board).toContain("4,00B")
    expect(board).toContain("width:75%")
    expect(board).toContain("width:25%")
    expect(board).toContain("width:50%")
  })

  test("the header carries the threshold counts and the trades pill", async () => {
    const panel = feed(
      await withWhales({
        thresholds: { symbols: 812, warmingUp: 640 },
        provenance: {
          feed: "stockbit-running-trades",
          source: "extension",
          asOf: enrgSweep.updatedAt,
          freshness: "live",
        },
      })
    )
    expect(panel).toContain("Thresholds on 812 symbols, 640 still warming up")
    expect(panel).toContain("LIVE")
    expect(panel).toContain("trades")
  })

  test("the header carries the liveprice pill apart from the trades one", async () => {
    const panel = feed(
      await withWhales({
        liveprice: {
          feed: "stockbit-liveprice",
          source: "extension",
          asOf: enrgSweep.updatedAt,
          freshness: "stale",
        },
      })
    )
    expect(panel).toContain("liveprice")
    expect(panel).toContain("STALE")
  })

  test("the walls are labelled with the wall coverage count, with ≥ on both counts", async () => {
    const panel = feed(
      await withWhales({
        walls: [bbcaWall],
        sweeps: [enrgSweep],
        sweepsTotal: 1,
        wallCoverage: [
          { symbol: bbcaWall.symbol, receiving: true },
          { symbol: enrgSweep.symbol, receiving: false },
        ],
      })
    )
    expect(panel).toContain("Walls · 2 symbols watched")
    expect(panel).toContain(`href="/radar/live?s=${bbcaWall.symbol}"`)
    expect(panel).toContain("≥")
    expect(panel).toMatch(/\d\d:\d\d:\d\d/)
  })

  test("a morning with walls and no sweeps lists the walls beside the empty feed", async () => {
    const panel = feed(
      await withWhales({
        walls: [bbcaWall],
        wallCoverage: [{ symbol: bbcaWall.symbol, receiving: true }],
      })
    )
    expect(panel).toContain("Belum ada sweep hari ini")
    expect(panel).toContain("Walls · 1 symbol watched")
    expect(panel).toContain(`href="/radar/live?s=${bbcaWall.symbol}"`)
    expect(panel).not.toContain("Most swept today")
  })

  test("every symbol opens on Whale Radar Live, in the feed, the leaderboard and the walls", async () => {
    const symbol = enrgSweep.symbol
    const panel = feed(
      await withWhales({
        sweeps: [enrgSweep],
        sweepsTotal: 1,
        leaderboard: [{ symbol, buyValue: 2, sellValue: 0 }],
        walls: [{ ...bbcaWall, symbol }],
        wallCoverage: [{ symbol, receiving: true }],
      })
    )
    expect(
      panel.match(new RegExp(`href="/radar/live\\?s=${symbol}"`, "g"))
    ).toHaveLength(3)
    expect(panel).toContain(`>${sweepLine(enrgSweep)}<`)
  })

  test("no coverage says walls are not watched, never an empty list", async () => {
    const off = feed(await withWhales({}))
    expect(off).toContain("Walls · 0 symbols watched")
    expect(off).toContain("Walls not watched")

    const on = feed(
      await withWhales({
        wallCoverage: [{ symbol: bbcaWall.symbol, receiving: false }],
      })
    )
    expect(on).toContain("None has reached a threshold")
    expect(on).not.toContain("Walls not watched")
  })
})

describe("RadarPage", () => {
  test("lists every candidate, with no watchlist mode", async () => {
    const html = await render("?mode=watchlist")
    expect(html).toMatch(/>6 kandidat · per /)
    expect(html).not.toContain("Watchlist-only")
  })

  test("the drawer follows the ticker in the URL", async () => {
    expect(drawerTicker(await render("?t=TLKM"))).toBe("TLKM")
  })

  test("without a ticker in the URL the drawer shows the top-confidence row", async () => {
    expect(drawerTicker(await render())).toBe("BBCA")
  })
})
