// Seam (2) of spec apinrdw/kumora#263 for the book heatmap (ticket
// apinrdw/kumora#267): the selected code's resting lots shade the candle chart
// behind its candles, live from the heatmap GET and the socket's books, and on
// a recorded day from the GET alone.
import {
  StockCode,
  WibDate,
  decodeRecordedCandles,
  decodeRecordedHeatmap,
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
import {
  ajaibTradeToday,
  freshCode,
  freshTradeNumbers,
  openIngest,
  wibToday,
} from "../support/ingest"
import { expect, test } from "../support/test"

const PAGE = "/market-live"

test.use({ storageState: MEMBER.storageState })

test("the selected code's book heatmap shades behind the candle chart's candles, live and on a recorded day", async ({
  page,
}) => {
  // A code of its own: today's object keeps every code's books.
  const code = freshCode("HM")
  const base = freshTradeNumbers()
  const sentAt = marketNow()
  const relay = await openIngest()
  // Ajaib's book, served while Stockbit has none of the code, and one trade
  // in the same minute, so the minute has a candle to shade behind.
  await relay.sendAjaib([
    JSON.stringify({
      ticker: code,
      is_initial: "true",
      buy: [
        { num: 12, price: 1000, lot: 340 },
        { num: 7, price: 995, lot: 120 },
      ],
      sell: [
        { num: 4, price: 1005, lot: 90 },
        { num: 9, price: 1010, lot: 610 },
      ],
      updateTime: sentAt,
    }),
    ajaibTradeToday({
      seq: base + 1,
      time: wibTime(sentAt),
      ticker: code,
      price: 1000,
      lot: 3,
    }),
  ])

  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
  const chart = page.getByRole("region", { name: "Chart" })
  await expect(chart).toContainText("One-minute candles: 1")
  // The object took the trade by now: its merge window is waited out from
  // here (market-live-recorded-day.spec.ts says why).
  const arrivedBy = marketNow()
  // Live, the current slice is built from the snapshot's book at once.
  const canvas = chart.locator('[data-chart="candles"]')
  await expect(canvas).toHaveAttribute("data-heatmap-slices", /^[1-9]\d*$/)

  // A recorded day answers whole slices only: wait for the first.
  const day = WibDate.make(wibToday())
  const heatmapUrl = `${DASHBOARD}${Effect.runSync(
    recordedDayPath(day, { _tag: "Heatmap", code: StockCode.make(code) })
  )}`
  await expect
    .poll(
      async () => {
        const answer = await page.request.get(heatmapUrl)
        if (answer.status() !== 200) return 0
        const { slices } = await Effect.runPromise(
          decodeRecordedHeatmap(await answer.text())
        )
        return slices.length
      },
      { timeout: 20_000, intervals: [1_000] }
    )
    .toBeGreaterThan(0)
  // The relay closing flushes the candle, out of its merge window.
  await page.waitForTimeout(untilMarketTime(arrivedBy + MERGE_WINDOW))
  relay.close()
  const candlesUrl = `${DASHBOARD}${Effect.runSync(
    recordedDayPath(day, { _tag: "Candles", code: StockCode.make(code) })
  )}`
  await expect
    .poll(
      async () => {
        const answer = await page.request.get(candlesUrl)
        if (answer.status() !== 200) return 0
        const { candles } = await Effect.runPromise(
          decodeRecordedCandles(await answer.text())
        )
        return candles.length
      },
      { timeout: 15_000, intervals: [500] }
    )
    .toBe(1)

  // Today opened as a recorded day: the object answers what it holds.
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}&day=${day}`)
  await expect(
    page.getByRole("group", { name: "Market conditions" })
  ).toContainText("RECORDED")
  await expect(chart).toContainText("One-minute candles: 1")
  await expect(canvas).toHaveAttribute("data-heatmap-slices", /^[1-9]\d*$/)
})
