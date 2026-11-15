import {
  BROKER_CODES_AUTH_SCHEME,
  BrokerCode,
  BrokerCodesProtocolVersion,
  MINUTE_MS,
  TradeNumber,
  WibDate,
  decodeRecordedCandles,
  encodeBrokerCodesBatch,
  recordedDayPath,
  type TradeCodes,
} from "@workspace/relay"
import type { Locator } from "@playwright/test"
import { Effect } from "effect"

import { DASHBOARD, MEMBER } from "../support/accounts"
import {
  MERGE_WINDOW,
  marketNow,
  untilMarketTime,
  wibTime,
} from "../support/clock"
import {
  TEST_INGEST_TOKEN,
  ajaibTradeToday,
  freshCode,
  freshTradeNumbers,
  openIngest,
  wibToday,
} from "../support/ingest"
import { expect, newClientContext, test } from "../support/test"

const PAGE = "/market-live"

test.use({ storageState: MEMBER.storageState })

test("sweeps show as bubbles and log rows; top-N filters them; a row rings its bubble", async ({
  page,
}) => {
  const relay = await openIngest()
  const base = freshTradeNumbers()
  // A code of its own: today's object keeps every code's sweeps.
  const code = freshCode("SW")
  // Decision: the sweeps are over a minute old, so the relay gap that ends
  // when this relay opens always draws a minute after theirs. 30 seconds
  // back drew one only when a minute turned in between, 4 runs in 25.
  const start = marketNow() - 90_000
  // Each trade in a second of its own, so each is one sweep: buys of 1–8
  // lots, a big buy (20,000 lots at 500, Rp1 B), sells of 2, 4, 6 and 8.
  const sweeps = [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((lot) => ({ lot, type: "BUY" as const })),
    { lot: 20_000, type: "BUY" as const },
    ...[2, 4, 6, 8].map((lot) => ({ lot, type: "SELL" as const })),
  ].map((sweep, index) =>
    ajaibTradeToday({
      seq: base + index + 1,
      time: wibTime(start + index * 1_000),
      ticker: code,
      price: 500,
      ...sweep,
    })
  )
  // Some before the page opens, which its sweeps GET answers; the rest come
  // by the deltas.
  await relay.sendAjaib(sweeps.slice(0, 6))
  // Live, no sweep can have brokers: the page never asks for them.
  const brokersAsked: Array<string> = []
  page.on("request", (request) => {
    if (request.url().includes("/sweep-brokers/"))
      brokersAsked.push(request.url())
  })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
  const log = page.getByRole("region", { name: "Sweep log" })
  await expect(log.getByRole("heading")).toHaveText(`Buy/Sell sweeps · ${code}`)
  // Live, no sweep can have brokers yet: the log has no broker columns.
  await expect(log).toContainText("Lots @ price")
  await expect(log).not.toContainText("Aggressor")
  expect((await log.boundingBox())?.width).toBe(340)
  const filter = log.getByLabel("Broker filter")
  await expect(filter).toBeDisabled()
  await expect(filter.getByRole("option")).toHaveText([
    "Brokers after the close",
  ])
  await relay.sendAjaib(sweeps.slice(6))

  const chart = page.getByRole("region", { name: "Chart" })
  const threshold = chart.getByLabel("Sweep threshold")
  const rows = log.locator("[data-sweep-id]")
  // Top 25%: buy's 3rd largest of 9 is 7 lots, sell's largest of 4 is 8.
  await expect(threshold).toHaveText("≥ 7 lots (buy 7, sell 8)")
  await expect(log).toContainText("13 sweeps · Buy 9 · Sell 4 · Big 1")
  await expect(rows).toHaveCount(4)
  // Newest first: the sell of 8, then the big buy.
  await expect(rows.first()).toContainText("Sell")
  await expect(rows.first()).toContainText("8 @ 500")
  await expect(rows.nth(1)).toHaveAttribute("data-big", "true")
  const candles = chart.locator('[data-chart="candles"]')
  await expect(candles).toHaveAttribute("data-bubbles", "4")

  await chart.getByRole("button", { name: "50%" }).click()
  await expect(threshold).toHaveText("≥ 5 lots (buy 5, sell 6)")
  await expect(rows).toHaveCount(7)
  await expect(candles).toHaveAttribute("data-bubbles", "7")
  await chart.getByRole("button", { name: "All" }).click()
  await expect(threshold).toHaveText("")
  await expect(rows).toHaveCount(13)
  // The slider steps by 5% and applies at once: down to its 5% end, where
  // each side's largest is the cut.
  const slider = chart.getByLabel("Top N percent of sweeps")
  await slider.press("Home")
  await expect(slider).toHaveValue("5")
  await expect(threshold).toHaveText("≥ 8 lots (buy 20,000, sell 8)")
  await expect(rows).toHaveCount(3)

  const bigOnly = log.getByRole("button", { name: "Big only" })
  await bigOnly.click()
  await expect(rows).toHaveCount(1)
  // The toggle is in the URL, so a shared link opens with it.
  await expect(page).toHaveURL(/[?&]big=true(&|$)/)
  // Chart 2 opens on the last 10 minutes drawn.
  const footprint = page.locator('[data-chart="footprint"]')
  const range = async () => ({
    from: Number(await footprint.getAttribute("data-from")),
    to: Number(await footprint.getAttribute("data-to")),
  })
  await expect
    .poll(async () => {
      const { from, to } = await range()
      return to - from
    })
    .toBe(9)
  const opened = await range()
  const big = rows.first()
  await big.click()
  await expect(big).toHaveAttribute("aria-current", "true")
  await expect(candles).toHaveAttribute(
    "data-ringed-sweep",
    (await big.getAttribute("data-sweep-id"))!
  )
  // The row moves chart 2 to the 10 minutes around the big buy's: its minute
  // is the 5th column, whose ladder names it.
  // Decision: the spec finds the minute by hovering, not by its bar index.
  // Relay gaps' minutes are drawn after the code's own as well as before
  // them, so no data-from or data-to tells which bar the newest sweep's is.
  await expect.poll(async () => (await range()).from).not.toBe(opened.from)
  const moved = await range()
  expect(moved.to - moved.from).toBe(9)
  const box = (await footprint.boundingBox())!
  // The price scale is 72 px wide.
  await page.mouse.move(box.x + ((box.width - 72) / 10) * 4.5, box.y + 120)
  await expect(
    page.getByRole("tooltip", { name: "Footprint ladder" })
  ).toContainText(`${wibTime(start + 8_000).slice(0, 5)} WIB`)

  await page.reload()
  await expect(bigOnly).toHaveAttribute("aria-pressed", "true")
  await expect(rows).toHaveCount(1)
  expect(brokersAsked).toEqual([])
  relay.close()
})

const tradeCodes = (text: string): TradeCodes => {
  const [buyer, buyerType, seller, sellerType] = text.split(" ")
  return {
    buyer: BrokerCode.make(buyer!),
    buyerType: buyerType === "F" ? "F" : "D",
    seller: BrokerCode.make(seller!),
    sellerType: sellerType === "F" ? "F" : "D",
  }
}

test("a recorded day's sweep log shows each sweep's lead brokers, wider, filling in as codes arrive, with their tooltip on a cell and a bubble", async ({
  page,
  browser,
}) => {
  // The recheck runs every 30 s.
  test.setTimeout(90_000)
  const relay = await openIngest()
  const base = freshTradeNumbers()
  const code = freshCode("SB")
  const day = WibDate.make(wibToday())
  // As the first test: a minute and more back, so no relay gap draws in it.
  // Both sweeps share a minute, so selecting either never pans chart 1 and
  // a bubble stays where it was read.
  const start =
    Math.floor((marketNow() - 90_000) / MINUTE_MS) * MINUTE_MS + 5_000
  // A buy sweep of two trades in one second, then a sell sweep of one.
  const second = (offset: number) => wibTime(start + offset * 1_000)
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 1,
      time: second(0),
      ticker: code,
      price: 500,
      lot: 10,
      type: "BUY",
    }),
    ajaibTradeToday({
      seq: base + 2,
      time: second(0),
      ticker: code,
      price: 505,
      lot: 30,
      type: "BUY",
    }),
    ajaibTradeToday({
      seq: base + 3,
      time: second(2),
      ticker: code,
      price: 500,
      lot: 5,
      type: "SELL",
    }),
  ])
  const arrivedBy = marketNow()
  // The relay closing flushes what has left its merge window (candles.ts),
  // so the trades are stored once it closes after it.
  await page.waitForTimeout(untilMarketTime(arrivedBy + MERGE_WINDOW))
  relay.close()
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
    .toBe(45)

  // The extension stores the trades' codes in batches, as a walk does.
  const storeCodes = async (rows: ReadonlyArray<[number, string]>) => {
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
            rows: rows.map(([offset, text]) => [
              TradeNumber.make(String(base + offset)),
              tradeCodes(text),
            ]),
          })
        ),
      }
    )
    expect(posted.status()).toBe(200)
  }
  // AK bought more of the buy sweep than BK did; KZ sold the sell sweep.
  // The buy sweep's first trade has no codes yet.
  await storeCodes([
    [2, "AK F CC D"],
    [3, "YP D KZ F"],
  ])

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}&day=${day}`)
  const log = page.getByRole("region", { name: "Sweep log" })
  await expect(log).toContainText("Aggressor")
  expect((await log.boundingBox())?.width).toBe(530)
  const rows = log.locator("[data-sweep-id]")
  await expect(rows).toHaveCount(2)
  // Newest first: the sell sweep, then the buy sweep, not yet whole, blank.
  await expect(rows.first()).toContainText("KZ [F]")
  await expect(rows.nth(1)).not.toContainText("[")
  // The test day's codes stay incomplete: every spec's trades share it.
  const note = log.getByText(/^Codes still arriving/)
  await expect(note).toHaveText(
    "Codes still arriving: 1 of 2 sweeps have their brokers. Updates every 30 s."
  )

  // The walk stores the last trade's codes; the page's recheck fills the
  // buy sweep in within 30 s, with no reload.
  await storeCodes([[1, "BK D CC D"]])
  await expect(rows.nth(1)).toContainText("AK [F] +1", { timeout: 40_000 })
  await expect(rows.nth(1).getByText("AK [F]")).toHaveClass(/text-foreign/)
  await expect(note).toHaveText(
    "Codes still arriving: 2 of 2 sweeps have their brokers. Updates every 30 s."
  )
  // Other side: YP bought the sell sweep, CC sold the buy sweep.
  await expect(log).toContainText("Other side")
  await expect(rows.first()).toContainText("YP [D]")
  await expect(rows.nth(1)).toContainText("CC [D]")

  // A broker cell's tooltip lists every broker of the sweep with its lots,
  // the aggressors first.
  const tip = page.getByRole("tooltip", { name: "Sweep brokers" })
  const buyTip = [
    "Buyers · aggressor",
    /^AK \[F\]\s*30$/,
    /^BK \[D\]\s*10$/,
    "Sellers",
    /^CC \[D\]\s*40$/,
  ]
  await rows.nth(1).getByText("CC [D]").hover()
  await expect(tip).toContainText("Buy 40 lots @ 500→505 · 2 trades")
  await expect(tip.getByRole("row")).toHaveText(buyTip)
  await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()

  // A bubble on chart 1 shows the same tooltip on hover, and a click on it
  // still selects its row.
  const candles = page.locator('[data-chart="candles"]')
  // The first selection pans chart 1 to the sweeps' minute, at times a draw
  // after its ring; a selection in that minute then never moves it.
  await rows.first().click()
  await ringedBubble(
    candles,
    (await rows.first().getAttribute("data-sweep-id"))!
  )
  await rows.nth(1).click()
  const buyBubble = await ringedBubble(
    candles,
    (await rows.nth(1).getAttribute("data-sweep-id"))!
  )
  await page.mouse.move(buyBubble.x, buyBubble.y)
  await expect(tip.getByRole("row")).toHaveText(buyTip)
  await rows.first().click()
  await expect(rows.first()).toHaveAttribute("aria-current", "true")
  await page.mouse.click(buyBubble.x, buyBubble.y)
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true")

  // The broker filter lists the aggressors by their summed lots. Picking AK
  // keeps only the sweeps AK was an aggressor of, each read as AK's lots of
  // the whole, in the log and in chart 1's bubbles; the top-N cuts by AK's
  // lots, and the tooltip marks AK.
  const filter = log.getByLabel("Broker filter")
  await expect(filter.getByRole("option")).toHaveText([
    "All brokers",
    "AK [F] · 30",
    "BK [D] · 10",
    "KZ [F] · 5",
  ])
  // The sell sweep, which AK has no part in, selected first.
  await rows.first().click()
  await filter.selectOption("AK")
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).not.toHaveAttribute("aria-current", "true")
  await expect(rows.first()).toContainText("30/40 @ 500→505")
  await expect(candles).toHaveAttribute("data-bubbles", "1")
  await expect(page.getByLabel("Sweep threshold")).toHaveText(
    "≥ 30 lots of AK (buy 30)"
  )
  await page.mouse.move(buyBubble.x, buyBubble.y)
  await expect(tip.getByRole("row")).toHaveText([
    "Buyers · aggressor",
    /^AK \[F\] ◂\s*30$/,
    /^BK \[D\]\s*10$/,
    "Sellers",
    /^CC \[D\]\s*40$/,
  ])
  // Selecting works with the filter on, from a row and from a bubble.
  await rows.first().click()
  await expect(rows.first()).toHaveAttribute("aria-current", "true")
  await filter.selectOption("")
  await expect(rows).toHaveCount(2)
  await rows.first().click()
  await expect(rows.first()).toHaveAttribute("aria-current", "true")
  await filter.selectOption("AK")
  await expect(rows).toHaveCount(1)
  await page.mouse.click(buyBubble.x, buyBubble.y)
  await expect(rows.first()).toHaveAttribute("aria-current", "true")
  await expect(candles).toHaveAttribute(
    "data-ringed-sweep",
    (await rows.first().getAttribute("data-sweep-id"))!
  )
  await filter.selectOption("")
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(1)).toContainText("40 @ 500→505")
  await expect(rows.nth(1)).not.toContainText("/")

  // On a phone the Sweeps tab shows both broker columns, and a tap on a
  // broker cell or a bubble shows the tooltip.
  const phone = await (
    await newClientContext(browser, {
      context: {
        storageState: MEMBER.storageState,
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    })
  ).newPage()
  await phone.goto(`${DASHBOARD}${PAGE}?code=${code}&day=${day}&panel=sweeps`)
  const phoneLog = phone.getByRole("region", { name: "Sweep log" })
  const phoneRows = phoneLog.locator("[data-sweep-id]")
  const phoneTip = phone.getByRole("tooltip", { name: "Sweep brokers" })
  await expect(phoneRows).toHaveCount(2)
  await expect(phoneLog.getByText("Aggressor", { exact: true })).toBeVisible()
  await expect(phoneLog.getByText("Other side")).toBeVisible()
  // As above: one selection first, so chart 1 has panned once read.
  await phoneRows.first().getByText("Sell").tap()
  await expect(phoneRows.first()).toHaveAttribute("aria-current", "true")
  await phoneRows.nth(1).getByText("AK [F]").tap()
  await expect(phoneTip.getByRole("row")).toHaveText(buyTip)
  await phoneLog.getByRole("heading").tap()
  await expect(phoneTip).toBeHidden()
  const phoneCandles = phone.locator('[data-chart="candles"]')
  await phoneCandles.scrollIntoViewIfNeeded()
  const phoneBubble = await ringedBubble(
    phoneCandles,
    (await phoneRows.nth(1).getAttribute("data-sweep-id"))!
  )
  await phone.touchscreen.tap(phoneBubble.x, phoneBubble.y)
  await expect(phoneTip.getByRole("row")).toHaveText(buyTip)
})

// The ringed bubble's centre in the viewport, once it is `id`'s and a
// redraw no longer moves it (a selection can pan chart 1 a frame later).
async function ringedBubble(candles: Locator, id: string) {
  await expect(candles).toHaveAttribute("data-ringed-sweep", id)
  let last: string | null = null
  await expect
    .poll(
      async () => {
        const at = await candles.getAttribute("data-ringed-at")
        const settled = at === last
        last = at
        return settled
      },
      { intervals: [100] }
    )
    .toBe(true)
  const [x, y] = last!.split(",").map(Number)
  const box = (await candles.boundingBox())!
  return { x: box.x + x!, y: box.y + y! }
}
