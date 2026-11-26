// Seam (b) of spec apinrdw/kumora#138, a recorded day: the day strip opens a
// day at its close under `?day=`, with its whole-day candles, the watchlist
// rows worked out in the browser, its tape and the RECORDED pill; the replay
// cursor scrubs back, plays forward and reads "Not recorded" in a relay gap;
// Today · live goes back to the live page; a 401 answer sends the viewer to
// sign in. The tape's Buyer and Seller show the broker codes the extension
// posted (spec apinrdw/kumora#280).
import {
  BROKER_CODES_AUTH_SCHEME,
  BrokerCode,
  BrokerCodesProtocolVersion,
  TradeNumber,
  type StockCode,
  WibDate,
  decodeRecordedCandles,
  encodeBrokerCodesBatch,
  recordedDayPath,
} from "@workspace/relay"
import type { Page } from "@playwright/test"
import { Effect } from "effect"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { cursorPlace, volumeInk } from "../support/chart"
import {
  MERGE_WINDOW,
  marketNow,
  untilMarketTime,
  wibTime,
} from "../support/clock"
import { signInUrl } from "../support/flows"
import {
  TEST_INGEST_TOKEN,
  ajaibTradeToday,
  freshCode,
  freshTradeNumbers,
  openIngest,
  wibToday,
} from "../support/ingest"
import { expect, test } from "../support/test"

const PAGE = "/market-live"
const WATCHLIST_KEY = "kumora:market-live:watchlist"

test.use({ storageState: MEMBER.storageState })

// Waits until `day`'s recorded candles of `code` hold `volume` lots: the
// relay's close flushed its trades.
const untilRecorded = (
  page: Page,
  day: WibDate,
  code: StockCode,
  volume: number
) => {
  const candlesUrl = `${DASHBOARD}${Effect.runSync(
    recordedDayPath(day, { _tag: "Candles", code })
  )}`
  return expect
    .poll(
      async () => {
        const answer = await page.request.get(candlesUrl)
        if (answer.status() !== 200) return 0
        const { candles } = await Effect.runPromise(
          decodeRecordedCandles(await answer.text())
        )
        return candles.reduce((sum, candle) => sum + candle.volume, 0)
      },
      { timeout: 15_000, intervals: [500] }
    )
    .toBe(volume)
}

test("the day strip opens a recorded day at its close, it replays, and Today · live returns", async ({
  page,
}) => {
  const base = freshTradeNumbers()
  // A code of its own: today's object keeps every code's candles.
  const code = freshCode("RP")
  const day = WibDate.make(wibToday())
  const sentAt = marketNow()
  const time = wibTime(sentAt)
  const relay = await openIngest()
  await relay.sendAjaib([
    ajaibTradeToday({ seq: base + 1, time, ticker: code, price: 500, lot: 3 }),
    ajaibTradeToday({ seq: base + 2, time, ticker: code, price: 505, lot: 2 }),
  ])
  // Today has not sealed, so the index lists no day yet: the strip is
  // answered with today as a recorded day, whose GETs the object answers
  // from what it flushed.
  await page.route(
    (url) => url.pathname === "/market-live/days",
    (route) =>
      route.fulfill({
        json: {
          days: [
            {
              day,
              ihsg: { close: 7_035, change: 35, changePercent: 0.5 },
              trades: 2,
              gap: false,
            },
          ],
        },
      })
  )
  // A relay gap ending 5 minutes before the trades.
  const gapFrom = Math.floor(sentAt / 1_000) * 1_000 - 15 * 60_000
  const gapTo = gapFrom + 10 * 60_000
  await page.route(
    (url) => url.pathname === `/market-live/days/${day}/gaps`,
    (route) => route.fulfill({ json: { gaps: [{ from: gapFrom, to: gapTo }] } })
  )
  await page.addInitScript(
    ([key, watched]) => window.localStorage.setItem(key, watched),
    [WATCHLIST_KEY, JSON.stringify([code])] as const
  )
  // A desktop's width: 10 minutes of the footprint chart then read as text.
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}&panel=tape`)
  const conditions = page.getByRole("group", { name: "Market conditions" })
  await expect(conditions.getByRole("list", { name: "Feeds" })).toBeVisible()

  // The merge window is waited out from when the live page shows
  // the trades, not from `sentAt`. The window opens when the object takes a
  // trade (candles.ts), which is after the spec sent it and no later than the
  // page showing it, so a slow connection or object can't make the relay
  // close on trades still inside it.
  const tape = page.getByRole("region", { name: "Running trades" })
  await expect(
    tape.locator(`tr[data-trade-number="${base + 2}"]`)
  ).toBeVisible()
  const arrivedBy = marketNow()
  // The relay closing flushes at once what has left its 5 s merge window
  // (candles.ts), so it closes once the trades have, rather than waiting for
  // the next minute's flush.
  await page.waitForTimeout(untilMarketTime(arrivedBy + MERGE_WINDOW))
  relay.close()

  // Recorded once the close's flush has run.
  await untilRecorded(page, day, code, 5)

  const strip = page.getByRole("navigation", { name: "Trading days" })
  await strip.getByRole("link", { name: /IHSG \+0\.50%/ }).click()
  await expect(page).toHaveURL(new RegExp(`[?&]day=${day}(&|$)`))
  await expect(conditions).toContainText("RECORDED")
  await expect(conditions).toContainText("at the close")
  await expect(conditions.getByRole("list", { name: "Feeds" })).toHaveCount(0)
  await expect(strip.getByRole("link", { name: /IHSG/ })).toHaveAttribute(
    "aria-current",
    "page"
  )

  await expect(page.getByText("One-minute candles: 1")).toBeAttached()
  // At the close, the candle chart's volume bar shows the 5 lots bought in
  // green.
  const candles = page.locator('[data-chart="candles"]')
  await expect
    .poll(async () => (await volumeInk(candles)).buy)
    .toBeGreaterThan(0)
  // The footprint chart draws the recorded footprint: 5 lots bought.
  const footprint = page.getByRole("region", { name: "Footprint" })
  const tradedMinute = `${time.slice(0, 5)}:00`
  await expect(footprint).toContainText(
    `Footprint minutes: 1. ${tradedMinute}: Vol 5, Δ +5, CVD +5`
  )
  await expect(footprint.locator('[data-chart="footprint"]')).toHaveAttribute(
    "data-draw-mode",
    "text"
  )
  const row = page
    .getByRole("region", { name: "Watchlist" })
    .locator(`tr[data-code="${code}"]`)
  // Last 505; 5 lots in 2 trades.
  await expect(row.locator("td").nth(1)).toHaveText("505")
  await expect(row.locator("td").nth(4)).toHaveText("5")
  await expect(row.locator("td").nth(5)).toHaveText("2")
  await expect(
    tape.locator(`tr[data-trade-number="${base + 2}"]`)
  ).toBeVisible()

  // Scrubbed back into the relay gap: nothing traded yet, and the book and
  // tape say it wasn't recorded.
  const scrubber = page.getByRole("slider", { name: "Replay cursor" })
  await scrubber.fill(String(gapFrom + 60_000))
  await expect(conditions).toContainText(`at ${wibTime(gapFrom + 60_000)}`)
  await expect(tape.locator(`tr[data-trade-number="${base + 2}"]`)).toHaveCount(
    0
  )
  await expect(tape.locator("tr[data-relay-gap]")).toContainText("Not recorded")
  await expect(page.getByRole("region", { name: "Order book" })).toContainText(
    "Not recorded"
  )
  await expect(row).toContainText("no data yet")
  // The footprint follows the cursor: its minute hasn't come yet.
  await expect(footprint).toContainText("Footprint minutes: 0")
  // The candle chart's volume bar is greyed: its minute comes after the cursor.
  await expect.poll(() => volumeInk(candles)).toEqual({ buy: 0, sell: 0 })
  // The scrubber shades the gap.
  await expect(
    page
      .getByRole("group", { name: "Replay" })
      .locator('[title="Not recorded"]')
  ).toHaveCount(1)

  // Past the gap, then Play at 60× runs into the trades.
  await scrubber.fill(String(gapTo + 60_000))
  await expect(
    page.getByRole("region", { name: "Order book" })
  ).not.toContainText("Not recorded")
  const replay = page.getByRole("group", { name: "Replay" })
  await replay.getByRole("button", { name: "60×" }).click()
  await replay.getByRole("button", { name: "Play" }).click()
  await expect(row.locator("td").nth(1)).toHaveText("505", { timeout: 15_000 })
  await expect(
    tape.locator(`tr[data-trade-number="${base + 2}"]`)
  ).toBeVisible()
  await replay.getByRole("button", { name: "Pause" }).click()
  await expect(replay.getByRole("button", { name: "Play" })).toBeVisible()

  // Half way through the trades' minute, the cursor line sits half way from
  // that minute's centre to the next.
  const tradedAt = Math.floor(sentAt / 60_000) * 60_000
  await scrubber.fill(String(tradedAt + 30_000))
  await expect(conditions).toContainText(`at ${wibTime(tradedAt + 30_000)}`)
  await expect
    .poll(async () => {
      const { x, minute, spacing } = await cursorPlace(candles)
      return Math.round(((x - minute) / spacing) * 100) / 100
    })
    .toBe(0.5)
  const { x, minute, spacing } = await cursorPlace(candles)
  expect(minute).toBeGreaterThan(0)
  expect(spacing).toBeGreaterThan(0)
  expect(x).toBeGreaterThan(minute)
  expect(x).toBeLessThan(minute + spacing)

  // Dragged to its end, its last whole-second step, the cursor is at the
  // close, not a second before.
  await scrubber.fill(String(Number(await scrubber.getAttribute("max")) - 999))
  await expect(conditions).toContainText("at the close")

  await strip.getByRole("link", { name: "Today · live" }).click()
  await expect(page).not.toHaveURL(/[?&]day=/)
  await expect(conditions.getByRole("list", { name: "Feeds" })).toBeVisible()
})

test("a recorded day's tape shows each trade's Buyer and Seller as the extension stored them", async ({
  page,
}) => {
  const base = freshTradeNumbers()
  const code = freshCode("BK")
  const day = WibDate.make(wibToday())
  const time = wibTime(marketNow())
  const relay = await openIngest()
  // Trade base + 1 carries the widest figures tape-list.tsx's COLUMN_PX
  // promises to fit, and is bold as a big trade.
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 1,
      time,
      ticker: code,
      price: 45_000,
      lot: 123_456,
    }),
    ajaibTradeToday({ seq: base + 2, time, ticker: code, price: 505, lot: 2 }),
  ])
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}&panel=tape`)
  const tape = page.getByRole("region", { name: "Running trades" })
  const cells = (n: number) =>
    tape.locator(`tr[data-trade-number="${n}"]`).locator("td")
  // The live tape has no codes: its Buyer and Seller are blank.
  await expect(cells(base + 2).nth(2)).toContainText("505")
  await expect(cells(base + 2).nth(5)).toHaveText("")
  await expect(cells(base + 2).nth(6)).toHaveText("")
  const arrivedBy = marketNow()
  // As the first test: closed once the trades left the merge window, and
  // recorded once the close's flush has run.
  await page.waitForTimeout(untilMarketTime(arrivedBy + MERGE_WINDOW))
  relay.close()
  await untilRecorded(page, day, code, 123_458)

  // The extension stores the day's codes for trade base + 1 only.
  const posted = await page.request.post(
    `${DASHBOARD}/api/broker-codes/${day}`,
    {
      headers: {
        authorization: `${BROKER_CODES_AUTH_SCHEME}${TEST_INGEST_TOKEN}`,
      },
      data: Effect.runSync(
        encodeBrokerCodesBatch({
          version: BrokerCodesProtocolVersion,
          feed: "Ajaib",
          day,
          rows: [
            [
              TradeNumber.make(String(base + 1)),
              {
                buyer: BrokerCode.make("AK"),
                buyerType: "F",
                seller: BrokerCode.make("CD"),
                sellerType: "D",
              },
            ],
          ],
        })
      ),
    }
  )
  expect(posted.status()).toBe(200)

  await page.goto(`${DASHBOARD}${PAGE}?code=${code}&day=${day}&panel=tape`)
  await expect(
    page.getByRole("group", { name: "Market conditions" })
  ).toContainText("RECORDED")
  // A recorded day's middle column has the live page's tabs but All codes,
  // which is live only, on the tape.
  const tabs = page.getByRole("tablist", { name: "Trades" })
  await expect(tabs.getByRole("tab")).toHaveText([
    `Buy/Sell sweeps · ${code}`,
    "Running trades",
  ])
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText(
    "Running trades"
  )
  // The price cell keeps its index; Buyer and Seller follow Value.
  await expect(cells(base + 1).nth(2)).toContainText("45,000")
  await expect(cells(base + 1).nth(3)).toHaveText("123,456")
  await expect(cells(base + 1).nth(4)).toHaveText("Rp555.55 B")
  await expect(cells(base + 1).nth(5)).toHaveText("AK [F]")
  await expect(cells(base + 1).nth(6)).toHaveText("CD [D]")
  // Price, Lot, Value, Buyer and Seller each show their whole text, at the
  // desktop layout and at a phone's width.
  const clipped = () =>
    cells(base + 1).evaluateAll((tds) =>
      tds
        .slice(2, 7)
        .filter((td) => td.scrollWidth > td.clientWidth)
        .map((td) => td.textContent)
    )
  expect(await clipped()).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  // A phone shows one panel at a time (layout-b.tsx).
  await page.getByRole("tab", { name: "Tape" }).click()
  await expect(cells(base + 2).nth(2)).toContainText("505")
  expect(await clipped()).toEqual([])
  await expect(cells(base + 2).nth(5)).toHaveText("")
  await expect(cells(base + 2).nth(6)).toHaveText("")
})

test("a 401 recorded day answer sends the viewer to sign in", async ({
  page,
}) => {
  await page.route(
    (url) => url.pathname.startsWith("/market-live/days/"),
    (route) =>
      route.fulfill({
        status: 401,
        json: { error: "Unauthorized", message: "Sign in" },
      })
  )
  const path = `${PAGE}?day=${wibToday()}`
  await page.goto(`${DASHBOARD}${path}`)
  await expect(page).toHaveURL(signInUrl(path), { timeout: 15_000 })
})
