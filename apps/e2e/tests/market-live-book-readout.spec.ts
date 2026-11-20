// The Book readout of spec apinrdw/kumora#517: under the candle chart, live
// from the trading-day object's readings, greyed with the phase outside
// Sessions 1 and 2, and on a recorded day read from the stored frame at the
// replay cursor; its fill estimate walks the selected code's book in this
// browser's order size. Its book events part lists the code's events, which
// the ladder and the heatmap mark too.
import type { Page } from "@playwright/test"
import {
  StockCode,
  WibDate,
  encodeBookChunk,
  encodeRecordedBookEvents,
  type BookEvent,
  type OrderBook,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { marketNow, wibInstant, wibTime } from "../support/clock"
import { seedSpecialBoard } from "../support/holdings"
import {
  ajaibTradeToday,
  freshCode,
  freshTradeNumbers,
  openIngest,
  wibToday,
} from "../support/ingest"
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
  // 100 lots per order a side: the heavy bids hold small orders.
  await expect(readout.getByLabel("Imbalance reading")).toHaveText(
    "+50% · Bid-heavy · small orders"
  )
  // 300 bid lots in 3 orders, 100 offered in 1; nothing but lots per order.
  await expect(
    readout.getByRole("table", { name: "Bid and offer readings" })
  ).toHaveText("Bid · best 5Offer · best 5Lots per order100100")
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
                [{ price: 1005, lots: 300, orders: 1 }]
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
  await expect(readout).toContainText("recorded frame 11:00:00")
  // 300 offered lots in 1 order against 100 bid in 1.
  await expect(readout.getByLabel("Imbalance reading")).toHaveText(
    "−50% · Offer-heavy · big orders"
  )
  await page
    .getByRole("slider", { name: "Replay cursor" })
    .fill(String(morning + 30_000))
  await expect(readout.getByLabel("Imbalance value")).toHaveText("+50%")
  await expect(readout).toContainText("recorded frame 10:00:00")
  await expect(readout.getByLabel("Imbalance reading")).toHaveText(
    "+50% · Bid-heavy · small orders"
  )
})

// Ten 1,000-lot bids from 1,000 down; at 990, a wall of 6,000 lots in 2
// orders when `wall`. Rp500 M is about 5,000 lots there.
const bidLevels = (wall: boolean) =>
  Array.from({ length: 10 }, (_, k) => {
    const price = 1000 - 5 * k
    return wall && price === 990
      ? ([price, 2, 6000] as const)
      : ([price, 10, 1000] as const)
  })

test("a wall that appears is listed, marked on the ladder and on the heatmap", async ({
  page,
}) => {
  const code = freshCode("BE")
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
  const readout = page.getByRole("region", { name: "Book readout" })
  const events = readout.getByRole("region", { name: "Events" })
  // Just picked: this browser has heard no 30 s of its book yet.
  await expect(events).toContainText("No book events yet today.")
  await expect(events).not.toContainText("Too quiet to read")
  const relay = await openIngest()
  const now = marketNow()
  // One trade in the wall's minute, so it has a candle for the heatmap mark.
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: freshTradeNumbers() + 1,
      time: wibTime(now - 5_000),
      ticker: code,
      price: 1005,
      lot: 1,
    }),
  ])
  // Bid frames stamped 40 s and 20 s ago, then one 5 s ago with the wall,
  // each in its own delta: the last one's window reads the first two.
  for (const [ago, wall] of [
    [40_000, false],
    [20_000, false],
    [5_000, true],
  ] as const) {
    await relay.sendStockbit([
      stockbitOrderBookFrame(code, "BID", bidLevels(wall), now - ago),
      ...(ago === 40_000
        ? [stockbitOrderBookFrame(code, "OFFER", [[1005, 10, 900]], now - ago)]
        : []),
    ])
    await page.waitForTimeout(600)
  }
  const row = events.getByRole("button", { name: /Wall appeared/ })
  await expect(row).toContainText("6 K lots at 990 · 2 orders · 2 ticks away")
  const book = page.getByRole("region", { name: "Order book" })
  await expect(book.locator("abbr", { hasText: "W+" })).toHaveAttribute(
    "title",
    "Wall appeared: 6 K lots at 990 · 2 orders · 2 ticks away"
  )
  await expect(book).toContainText("Marks on a level: AB absorbed")
  const chart = page.locator('[data-chart="candles"]')
  await expect(chart).toHaveAttribute("data-book-events", "1")
  await row.click()
  await expect(row).toHaveAttribute("aria-pressed", "true")
  await expect(chart).toHaveAttribute("data-picked-event-at", /,/)
  relay.close()
})

// A recorded day with no gaps whose day strip lists it, its chunks unrouted.
const recordedDay = async (page: Page, day: WibDate) => {
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
}

test("on a recorded day the events after the cursor are dimmed", async ({
  page,
}) => {
  const code = StockCode.make(freshCode("BV"))
  const day = WibDate.make(wibToday())
  const at = (time: string) => DateTime.makeUnsafe(wibInstant(`${day}T${time}`))
  const stored: ReadonlyArray<BookEvent> = [
    {
      kind: "appeared",
      code,
      at: at("10:00:00"),
      side: "bid",
      price: 100,
      lots: 50_000,
      orders: 1,
      ticks: 6,
    },
    {
      kind: "pulled",
      code,
      at: at("11:00:00"),
      side: "bid",
      price: 100,
      lots: 50_000,
      orders: 1,
      ticks: 1,
      approached: true,
    },
  ]
  await recordedDay(page, day)
  await page.route(
    (url) => url.pathname === `/market-live/days/${day}/book-events/${code}`,
    (route) =>
      route.fulfill({
        contentType: "application/json",
        body: Effect.runSync(
          encodeRecordedBookEvents({ code, recorded: true, events: stored })
        ),
      })
  )
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}&day=${day}`)
  const events = page.getByRole("region", { name: "Events" })
  const pulled = events.getByRole("button", { name: /Pulled/ })
  await expect(pulled).toContainText(
    "50 K lots at 100 · 1 order · 1 ticks, as price approached"
  )
  await expect(pulled).not.toHaveClass(/opacity-30/)
  await page
    .getByRole("slider", { name: "Replay cursor" })
    .fill(String(wibInstant(`${day}T10:30:00`)))
  await expect(pulled).toHaveClass(/opacity-30/)
  await expect(
    events.getByRole("button", { name: /Wall appeared/ })
  ).not.toHaveClass(/opacity-30/)
})

test("a day recorded before book events says so", async ({ page }) => {
  const code = StockCode.make(freshCode("BN"))
  const day = WibDate.make(wibToday())
  await recordedDay(page, day)
  await page.route(
    (url) => url.pathname === `/market-live/days/${day}/book-events/${code}`,
    (route) => route.fulfill({ json: { code, recorded: false, events: [] } })
  )
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}&day=${day}`)
  await expect(page.getByRole("region", { name: "Events" })).toContainText(
    "Book events not recorded before"
  )
})
