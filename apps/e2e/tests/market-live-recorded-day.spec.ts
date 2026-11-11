// Seam (b) of spec apinrdw/kumora#138, a recorded day: the day strip opens a
// day at its close under `?day=`, with its whole-day candles, the watchlist
// rows worked out in the browser, its tape and the RECORDED pill; the replay
// cursor scrubs back, plays forward and reads "Not recorded" in a relay gap;
// Today · live goes back to the live page; a 401 answer sends the viewer to
// sign in.
import {
  StockCode,
  WibDate,
  decodeRecordedCandles,
  recordedDayPath,
} from "@workspace/relay"
import { Effect } from "effect"

import { DASHBOARD, MEMBER } from "../support/accounts"
import {
  MERGE_WINDOW,
  marketNow,
  untilMarketTime,
  wibTime,
} from "../support/clock"
import { signInUrl } from "../support/flows"
import {
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

test("the day strip opens a recorded day at its close, it replays, and Today · live returns", async ({
  page,
}) => {
  const base = freshTradeNumbers()
  // A code of its own: today's object keeps every code's candles.
  const code = StockCode.make(freshCode("RP"))
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
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
  const conditions = page.getByRole("group", { name: "Market conditions" })
  await expect(conditions.getByRole("list", { name: "Feeds" })).toBeVisible()

  // Decision: the merge window is waited out from when the live page shows
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
  const candlesUrl = `${DASHBOARD}${Effect.runSync(
    recordedDayPath(day, { _tag: "Candles", code })
  )}`
  await expect
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
    .toBe(5)

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

  // Dragged to its end, its last whole-second step, the cursor is at the
  // close, not a second before.
  await scrubber.fill(String(Number(await scrubber.getAttribute("max")) - 999))
  await expect(conditions).toContainText("at the close")

  await strip.getByRole("link", { name: "Today · live" }).click()
  await expect(page).not.toHaveURL(/[?&]day=/)
  await expect(conditions.getByRole("list", { name: "Feeds" })).toBeVisible()
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
