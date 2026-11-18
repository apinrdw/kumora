// The Book readout of spec apinrdw/kumora#517: under the candle chart, live
// from the trading-day object's readings, greyed with the phase outside
// Sessions 1 and 2, and on a recorded day read from the stored frame at the
// replay cursor; its fill estimate walks the selected code's book in this
// browser's order size.
import {
  StockCode,
  WibDate,
  encodeBookChunk,
  type OrderBook,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { wibInstant } from "../support/clock"
import { seedSpecialBoard } from "../support/holdings"
import { freshCode, openIngest, wibToday } from "../support/ingest"
import { stockbitOrderBookFrame } from "../support/stockbit"
import { expect, test } from "../support/test"

test.use({ storageState: MEMBER.storageState })

const PAGE = "/market-live"

test("the readout shows the selected code's live readings and the disclaimer", async ({
  page,
}) => {
  // A code of its own: today's object keeps every code's book.
  const code = freshCode("BR")
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
  const readout = page.getByRole("region", { name: "Book readout" })
  await expect(readout).toContainText("No readings yet.")
  const relay = await openIngest()
  await relay.sendStockbit([
    stockbitOrderBookFrame(code, "BID", [[1000, 3, 300]]),
    stockbitOrderBookFrame(code, "OFFER", [[1010, 1, 100]]),
  ])
  // 300 bid lots against 100 offered.
  await expect(readout.getByLabel("Imbalance value")).toHaveText("+50%")
  await expect(
    readout.getByRole("meter", { name: "Imbalance" })
  ).toHaveAttribute("aria-valuenow", "50")
  // 1,000 to 1,010 is two Rp5 ticks.
  await expect(readout.getByLabel("Spread")).toHaveText("2 ticks · 1.00%")
  // 1,000 × 300 lots × 100 shares, its lots on hover.
  await expect(readout.getByTitle("300 lots")).toHaveText("Rp30 M")
  await expect(readout).toContainText(
    "They don't predict price and aren't advice to buy or sell."
  )
  relay.close()
})

test("a Special Monitoring Board code says why it has no readings", async ({
  page,
}) => {
  const code = freshCode("SB")
  // Before the page loads: it reads the board list once a visit.
  seedSpecialBoard([code])
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
  const readout = page.getByRole("region", { name: "Book readout" })
  await expect(readout).toContainText(
    "Special Monitoring Board: this code trades in a call auction all day, and no order book arrives for it."
  )
  await expect(readout.getByLabel("Imbalance value")).toHaveCount(0)
})

test("the fill estimate walks the book in rupiah or lots, kept on reload", async ({
  page,
}) => {
  const code = freshCode("BF")
  const relay = await openIngest()
  await relay.sendStockbit([
    stockbitOrderBookFrame(code, "BID", [
      [1000, 3, 300],
      [995, 1, 100],
    ]),
    stockbitOrderBookFrame(code, "OFFER", [
      [1010, 1, 100],
      [1015, 2, 200],
    ]),
  ])
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
  const readout = page.getByRole("region", { name: "Book readout" })
  const unit = readout.getByRole("group", { name: "Order size unit" })
  const size = readout.getByLabel("Order size", { exact: true })
  const fill = readout.getByRole("table", { name: "Fill estimate" })
  // The default Rp10 billion is more than both sides hold.
  await expect(unit.getByRole("button", { name: "Rupiah" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  // 100 lots at 1,010 and 200 at 1,015.
  await expect(readout).toContainText(
    "More than the 2 levels shown: the offers cover 300 lots (Rp30.4 M)."
  )
  await unit.getByRole("button", { name: "Lots" }).click()
  await size.fill("150")
  // A buy of 150 lots: 100 at 1,010 and 50 at 1,015, one tick up.
  await expect(fill).toContainText("1 tick · 0.17%")
  await expect(fill).toContainText("1,012")
  await expect(readout).not.toContainText("More than the")
  await page.reload()
  await expect(unit.getByRole("button", { name: "Lots" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
  await expect(size).toHaveValue("150")
  await expect(fill).toContainText("1 tick · 0.17%")
  relay.close()
})

test("outside Sessions 1 and 2 the readings grey out and name the phase", async ({
  page,
}) => {
  const code = freshCode("BP")
  const relay = await openIngest()
  await relay.sendStockbit([
    stockbitOrderBookFrame(code, "BID", [[500, 2, 40]]),
    stockbitOrderBookFrame(code, "OFFER", [[505, 2, 40]]),
  ])
  // The page's socket goes through Playwright, which tells the page the
  // market is on its break: the Test stage's clock runs in session 1.
  await page.routeWebSocket(/\/market-live\/live$/, (socket) => {
    const server = socket.connectToServer()
    server.onMessage((message) => {
      if (typeof message !== "string") return socket.send(message)
      const parsed = JSON.parse(message) as { conditions?: { phase: string } }
      if (parsed.conditions !== undefined) parsed.conditions.phase = "break"
      socket.send(JSON.stringify(parsed))
    })
  })
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
  const readout = page.getByRole("region", { name: "Book readout" })
  const paused = readout.locator("[data-paused]")
  await expect(paused).toContainText(/Break · readings (paused at|start at)/)
  await expect(readout.getByLabel("Imbalance value")).toHaveText("0%")
  relay.close()
})

test("on a recorded day the readings follow the replay cursor", async ({
  page,
}) => {
  const code = freshCode("BD")
  const day = WibDate.make(wibToday())
  const book = (
    at: number,
    bids: OrderBook["bids"],
    offers: OrderBook["offers"]
  ): OrderBook => ({
    _tag: "OrderBook",
    code: StockCode.make(code),
    bids,
    offers,
    bidLots: bids.reduce((sum, level) => sum + level.lots, 0),
    offerLots: offers.reduce((sum, level) => sum + level.lots, 0),
    at: DateTime.makeUnsafe(at),
    provenance: "Stockbit",
  })
  const morning = wibInstant(`${day}T10:00:00`)
  // Before 11:00 the bids lead; from 11:00 the offers.
  const turn = wibInstant(`${day}T11:00:00`)
  const chunkAt = (minute: number) =>
    Effect.runSync(
      encodeBookChunk({
        code: StockCode.make(code),
        minute: DateTime.makeUnsafe(minute),
        start:
          minute < turn
            ? book(
                morning,
                [{ price: 1000, lots: 300, orders: 3 }],
                [{ price: 1010, lots: 100, orders: 1 }]
              )
            : book(
                turn,
                [{ price: 1000, lots: 100, orders: 1 }],
                [{ price: 1005, lots: 300, orders: 3 }]
              ),
        deltas: [],
      })
    )
  await page.route(
    (url) => url.pathname === "/market-live/days",
    (route) =>
      route.fulfill({
        json: {
          days: [
            {
              day,
              ihsg: { close: 7_035, change: 35, changePercent: 0.5 },
              trades: 0,
              gap: false,
            },
          ],
        },
      })
  )
  await page.route(
    (url) => url.pathname === `/market-live/days/${day}/gaps`,
    (route) => route.fulfill({ json: { gaps: [] } })
  )
  await page.route(
    (url) => url.pathname === `/market-live/days/${day}/books/${code}`,
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: chunkAt(
          Number(new URL(route.request().url()).searchParams.get("minute"))
        ),
      })
  )
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}&day=${day}`)
  const readout = page.getByRole("region", { name: "Book readout" })
  // At the close: the 11:00 frame, the offers leading.
  await expect(readout.getByLabel("Imbalance value")).toHaveText("−50%")
  await expect(readout.getByLabel("Spread")).toHaveText("1 tick · 0.50%")
  await expect(readout).toContainText("recorded frame 11:00:00")
  await page
    .getByRole("slider", { name: "Replay cursor" })
    .fill(String(morning + 30_000))
  await expect(readout.getByLabel("Imbalance value")).toHaveText("+50%")
  await expect(readout).toContainText("recorded frame 10:00:00")
})
