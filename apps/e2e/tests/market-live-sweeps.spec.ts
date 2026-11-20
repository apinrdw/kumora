import {
  BROKER_CODES_AUTH_SCHEME,
  BrokerCode,
  BrokerCodesProtocolVersion,
  OrderNumber,
  TradeNumber,
  WibDate,
  decodeRecordedCandles,
  encodeBrokerCodesBatch,
  recordedDayPath,
  type StockCode,
  type TradeCodes,
} from "@workspace/relay"
import type { Locator, Page } from "@playwright/test"
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
  await expect(log).not.toContainText("Seller")
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
  // The footprint chart opens on the last 10 minutes drawn.
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
  // The row moves the footprint chart to the 10 minutes around the big buy's:
  // its minute is the 5th column, whose ladder names it.
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

// Closes `relay` once its last trade, sent just before, has left the merge
// window, which flushes it (candles.ts), and waits until today's candles of
// `code` hold `lots`.
async function closedOnceStored(
  page: Page,
  relay: Awaited<ReturnType<typeof openIngest>>,
  code: StockCode,
  lots: number
) {
  await page.waitForTimeout(untilMarketTime(marketNow() + MERGE_WINDOW))
  relay.close()
  const candlesUrl = `${DASHBOARD}${Effect.runSync(
    recordedDayPath(WibDate.make(wibToday()), { _tag: "Candles", code })
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
    .toBe(lots)
}

// Stores today's trades' codes, by trade number, and their buy and sell order
// numbers where given, in one batch, as the extension's walks do.
async function storeCodes(
  page: Page,
  rows: ReadonlyArray<
    | readonly [number, string]
    | readonly [number, string, readonly [number, number]]
  >
) {
  const day = WibDate.make(wibToday())
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
          rows: rows.map(([number, text, orders]) =>
            orders === undefined
              ? [TradeNumber.make(String(number)), tradeCodes(text)]
              : [
                  TradeNumber.make(String(number)),
                  tradeCodes(text),
                  null,
                  [OrderNumber.make(orders[0]), OrderNumber.make(orders[1])],
                ]
          ),
        })
      ),
    }
  )
  expect(posted.status()).toBe(200)
}

test("a recorded day's sweep log shows each sweep's lead brokers, wider, filling in as codes arrive, with their tooltip on a cell and a bubble", async ({
  page,
  browser,
}) => {
  // The recheck runs every 30 s.
  test.setTimeout(90_000)
  const relay = await openIngest()
  const earlier = freshTradeNumbers()
  const base = earlier + 1_000
  const code = freshCode("SB")
  const day = WibDate.make(wibToday())
  // Decision: the sweeps are stamped now, not a minute back as the first
  // test's. A codes batch reads their minute through the day store's search
  // on trade numbers (`highestWithin`, tape.ts), which takes numbers
  // to run in time order: stamped back, they lost their brokers once it
  // read an earlier spec's lower-numbered, later trade. PR apinrdw/kumora#349.
  const time = wibTime(marketNow())
  // Another code's trades, numbered below this test's as an earlier spec's
  // are, where that search reads them whatever ran before: sweeps stamped
  // before them lose their brokers every run.
  const earlierCode = freshCode("SE")
  // A buy sweep of two trades, then a sell sweep of one, in one second: they
  // share a minute, so selecting either never pans the candle chart and a
  // bubble stays where it was read.
  await relay.sendAjaib([
    ...[1, 600].map((seq) =>
      ajaibTradeToday({
        seq: earlier + seq,
        time,
        ticker: earlierCode,
        price: 500,
        lot: 1,
      })
    ),
    ajaibTradeToday({
      seq: base + 1,
      time,
      ticker: code,
      price: 500,
      lot: 10,
      type: "BUY",
    }),
    ajaibTradeToday({
      seq: base + 2,
      time,
      ticker: code,
      price: 505,
      lot: 30,
      type: "BUY",
    }),
    ajaibTradeToday({
      seq: base + 3,
      time,
      ticker: code,
      price: 500,
      lot: 5,
      type: "SELL",
    }),
  ])
  await closedOnceStored(page, relay, code, 45)

  // AK bought the whole buy sweep, from BK and CC; KZ sold the sell sweep.
  // The buy sweep's first trade has no codes yet.
  await storeCodes(page, [
    [base + 2, "AK F CC D"],
    [base + 3, "YP D KZ F"],
  ])

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}&day=${day}`)
  const log = page.getByRole("region", { name: "Sweep log" })
  await expect(log).toContainText("Buyer")
  expect((await log.boundingBox())?.width).toBe(530)
  // At 1280 px, beside the sidebar, the log gives way down to 340 px before
  // the charts do, and its broker columns scroll sideways.
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect.poll(async () => (await log.boundingBox())?.width).toBe(340)
  const charts = page.getByRole("region", { name: "Chart" })
  expect((await charts.boundingBox())?.width).toBeGreaterThanOrEqual(200)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await expect.poll(async () => (await log.boundingBox())?.width).toBe(530)
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
  await storeCodes(page, [[base + 1, "AK F BK D"]])
  await expect(rows.nth(1)).toContainText("AK [F]", { timeout: 40_000 })
  // One aggressor, so no +N; the other side has two.
  await expect(rows.nth(1)).not.toContainText("AK [F] +")
  await expect(rows.nth(1)).toContainText("CC [D] +1")
  await expect(rows.nth(1).getByText("AK [F]")).toHaveClass(/text-foreign/)
  await expect(note).toHaveText(
    "Codes still arriving: 2 of 2 sweeps have their brokers. Updates every 30 s."
  )
  // The columns swap with the side: YP bought the sell sweep from KZ, AK
  // bought the buy sweep from CC and BK.
  await expect(log).toContainText("Seller")
  await expect(rows.first().locator('[data-column="buyer"]')).toHaveText(
    "YP [D]"
  )
  await expect(rows.first().locator('[data-column="seller"]')).toHaveText(
    "KZ [F]"
  )
  await expect(rows.nth(1).locator('[data-column="buyer"]')).toHaveText(
    "AK [F]"
  )
  await expect(rows.nth(1).locator('[data-column="seller"]')).toHaveText(
    "CC [D] +1"
  )

  // A broker cell's tooltip lists every broker of the sweep with its lots,
  // the aggressors first.
  const tip = page.getByRole("tooltip", { name: "Sweep brokers" })
  const buyTip = [
    "Buyers · aggressor",
    /^AK \[F\]\s*40$/,
    "Sellers",
    /^CC \[D\]\s*30$/,
    /^BK \[D\]\s*10$/,
  ]
  await rows.nth(1).getByText("CC [D]").hover()
  await expect(tip).toContainText("Buy 40 lots @ 500→505 · 2 trades")
  await expect(tip.getByRole("row")).toHaveText(buyTip)
  await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()

  // A bubble on the candle chart shows the same tooltip on hover, and a click
  // on it still selects its row.
  const candles = page.locator('[data-chart="candles"]')
  // The first selection pans the candle chart to the sweeps' minute, at times a
  // draw after its ring; a selection in that minute then never moves it.
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
  // keeps only the sweeps AK was the aggressor of, each at its whole lots,
  // in the log and in the candle chart's bubbles; the top-N cuts by them, and
  // the tooltip marks AK.
  const filter = log.getByLabel("Broker filter")
  await expect(filter.getByRole("option")).toHaveText([
    "All brokers",
    "AK [F] · 40",
    "KZ [F] · 5",
  ])
  // The sell sweep, which AK has no part in, selected first.
  await rows.first().click()
  await filter.selectOption("AK")
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).not.toHaveAttribute("aria-current", "true")
  await expect(rows.first()).toContainText("40/40 @ 500→505")
  await expect(candles).toHaveAttribute("data-bubbles", "1")
  await expect(page.getByLabel("Sweep threshold")).toHaveText(
    "≥ 40 lots of AK (buy 40)"
  )
  await page.mouse.move(buyBubble.x, buyBubble.y)
  await expect(tip.getByRole("row")).toHaveText([
    "Buyers · aggressor",
    /^AK \[F\] ◂\s*40$/,
    "Sellers",
    /^CC \[D\]\s*30$/,
    /^BK \[D\]\s*10$/,
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

  // A tooltip pinned on a bubble hides once Play jumps the cursor back
  // before its sweep (apinrdw/kumora#371).
  await page.mouse.click(buyBubble.x, buyBubble.y)
  await expect(tip.getByRole("row")).toHaveText(buyTip)
  await page.keyboard.press("Space")
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible()
  await expect(tip).toBeHidden()

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
  await expect(phoneLog.getByText("Buyer", { exact: true })).toBeVisible()
  await expect(phoneLog.getByText("Seller", { exact: true })).toBeVisible()
  // As above: one selection first, so the candle chart has panned once read.
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

test("a recorded day's sweep with two sellers in one second splits into two rows and two bubbles once whole, and a pin on it moves to the larger", async ({
  page,
}) => {
  // The recheck runs every 30 s.
  test.setTimeout(90_000)
  const relay = await openIngest()
  const earlier = freshTradeNumbers()
  const base = earlier + 1_000
  const code = freshCode("SS")
  // As the test above: the sweep stamped now, above another code's trades.
  const time = wibTime(marketNow())
  const earlierCode = freshCode("SE")
  await relay.sendAjaib([
    ...[1, 600].map((seq) =>
      ajaibTradeToday({
        seq: earlier + seq,
        time,
        ticker: earlierCode,
        price: 500,
        lot: 1,
      })
    ),
    // One sell sweep: XL's 4 lots, then FZ's 10 and 6.
    ...[
      { seq: 1, price: 500, lot: 4 },
      { seq: 2, price: 495, lot: 10 },
      { seq: 3, price: 495, lot: 6 },
    ].map(({ seq, price, lot }) =>
      ajaibTradeToday({
        seq: base + seq,
        time,
        ticker: code,
        price,
        lot,
        type: "SELL",
      })
    ),
  ])
  await closedOnceStored(page, relay, code, 20)
  // FZ's last trade has no codes yet.
  await storeCodes(page, [
    [base + 1, "AK F XL D"],
    [base + 2, "CC D FZ D"],
  ])

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(
    `${DASHBOARD}${PAGE}?code=${code}&day=${WibDate.make(wibToday())}`
  )
  const log = page.getByRole("region", { name: "Sweep log" })
  const rows = log.locator("[data-sweep-id]")
  const candles = page.locator('[data-chart="candles"]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("20 @ 500→495")
  await expect(candles).toHaveAttribute("data-bubbles", "1")
  // Pinned on the whole sweep's bubble, before its codes land.
  await rows.first().click()
  const bubble = await ringedBubble(candles, String(base + 1))
  await page.mouse.click(bubble.x, bubble.y)
  const tip = page.getByRole("tooltip", { name: "Sweep brokers" })
  await expect(tip).toContainText("Brokers show once every trade")

  // The recheck finds it whole: FZ's piece and XL's, newest first by first
  // trade, each its own row and bubble, the pin and the selection on FZ's.
  await storeCodes(page, [[base + 3, "YP D FZ D"]])
  await expect(log).toContainText("2 sweeps · Buy 0 · Sell 2", {
    timeout: 40_000,
  })
  await expect(tip).toContainText("Sell 16 lots @ 495 · 2 trades")
  await expect(tip.getByRole("row")).toHaveText([
    "Sellers · aggressor",
    /^FZ \[D\]\s*16$/,
    "Buyers",
    /^CC \[D\]\s*10$/,
    /^YP \[D\]\s*6$/,
  ])
  // The pin sits on FZ's bubble, where a fresh click on it pins it, give
  // or take the click's whole pixels.
  const moved = (await tip.boundingBox())!
  const piece = await ringedBubble(candles, String(base + 2))
  await page.mouse.click(piece.x, piece.y)
  await expect(tip).toContainText("Sell 16 lots @ 495 · 2 trades")
  const fresh = (await tip.boundingBox())!
  expect(Math.abs(fresh.x - moved.x)).toBeLessThan(1.5)
  expect(Math.abs(fresh.y - moved.y)).toBeLessThan(1.5)
  // The top 25% of the pieces is FZ's alone.
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute("aria-current", "true")
  await page
    .getByRole("region", { name: "Chart" })
    .getByRole("button", { name: "All" })
    .click()
  await expect(rows).toHaveCount(2)
  await expect(candles).toHaveAttribute("data-bubbles", "2")
  await expect(rows.first()).toHaveAttribute("data-sweep-id", String(base + 2))
  await expect(rows.first()).toHaveAttribute("aria-current", "true")
  await expect(rows.first()).toContainText("16 @ 495")
  await expect(rows.first()).toContainText("FZ [D]")
  await expect(rows.first()).toContainText("CC [D] +1")
  await expect(rows.nth(1)).toContainText("4 @ 500")
  await expect(rows.nth(1)).toContainText("XL [D]")
  await expect(rows.nth(1)).toContainText("AK [F]")
})

test("a recorded day's sweep whose trades have order numbers splits by order run, with ×N after a run's aggressor and its orders in the tip", async ({
  page,
}) => {
  const relay = await openIngest()
  const earlier = freshTradeNumbers()
  const base = earlier + 1_000
  const code = freshCode("SO")
  // As the tests above: the sweep stamped now, above another code's trades.
  const time = wibTime(marketNow())
  const earlierCode = freshCode("SE")
  await relay.sendAjaib([
    ...[1, 600].map((seq) =>
      ajaibTradeToday({
        seq: earlier + seq,
        time,
        ticker: earlierCode,
        price: 500,
        lot: 1,
      })
    ),
    // One sell sweep, all XL's: 10 and 20 lots, then 5.
    ...[
      { seq: 1, price: 500, lot: 10 },
      { seq: 2, price: 495, lot: 20 },
      { seq: 3, price: 495, lot: 5 },
    ].map(({ seq, price, lot }) =>
      ajaibTradeToday({
        seq: base + seq,
        time,
        ticker: code,
        price,
        lot,
        type: "SELL",
      })
    ),
  ])
  await closedOnceStored(page, relay, code, 35)
  // XL's first two sell orders step by 2, one run; its third is 88 above,
  // a run of its own. CC's one buy order took both of the first run's
  // trades; YP's took the last. A sell's aggressor order is the larger.
  await storeCodes(page, [
    [base + 1, "CC D XL D", [1_515_001, 1_515_610]],
    [base + 2, "CC D XL D", [1_515_001, 1_515_612]],
    [base + 3, "YP D XL D", [1_515_100, 1_515_700]],
  ])

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(
    `${DASHBOARD}${PAGE}?code=${code}&day=${WibDate.make(wibToday())}`
  )
  const log = page.getByRole("region", { name: "Sweep log" })
  const rows = log.locator("[data-sweep-id]")
  await expect(log).toContainText("2 sweeps · Buy 0 · Sell 2")
  const all = page
    .getByRole("region", { name: "Chart" })
    .getByRole("button", { name: "All" })
  await all.click()
  await expect(all).toHaveAttribute("aria-pressed", "true")
  await expect(rows).toHaveCount(2)
  // Newest first by first trade: the one-order run, with no ×N, then the
  // two-order run.
  const one = log.locator(`[data-sweep-id="${base + 3}"]`)
  const two = log.locator(`[data-sweep-id="${base + 1}"]`)
  await expect(one).toContainText("5 @ 495")
  await expect(one.locator('[data-column="buyer"]')).toHaveText("YP [D]")
  await expect(one.locator('[data-column="seller"]')).toHaveText("XL [D]")
  await expect(two).toContainText("30 @ 500→495")
  await expect(two.locator('[data-column="buyer"]')).toHaveText("CC [D]")
  await expect(two.locator('[data-column="seller"]')).toHaveText("XL [D] ×2")

  const tip = page.getByRole("tooltip", { name: "Sweep brokers" })
  await two.getByText("XL [D]").hover()
  await expect(tip).toContainText("Sell 30 lots @ 500→495 · 2 trades")
  await expect(tip).toContainText(
    "2 aggressor orders #1515610–1515612 · biggest passive order 30 lots"
  )
  await page.mouse.move(0, 0)
  await one.getByText("XL [D]").hover()
  await expect(tip).toContainText(
    "1 aggressor order #1515700 · biggest passive order 5 lots"
  )
})

test("a pin on a recorded day's sweep whose larger piece keeps its id moves to that piece's bubble", async ({
  page,
}) => {
  // The recheck runs every 30 s.
  test.setTimeout(90_000)
  const relay = await openIngest()
  const earlier = freshTradeNumbers()
  const base = earlier + 1_000
  const code = freshCode("SP")
  // As the tests above: the sweep stamped now, above another code's trades.
  const time = wibTime(marketNow())
  const earlierCode = freshCode("SE")
  await relay.sendAjaib([
    ...[1, 600].map((seq) =>
      ajaibTradeToday({
        seq: earlier + seq,
        time,
        ticker: earlierCode,
        price: 500,
        lot: 1,
      })
    ),
    // One sell sweep: FZ's 10 lots at 500, then XL's 9 at 470.
    ...[
      { seq: 1, price: 500, lot: 10 },
      { seq: 2, price: 470, lot: 9 },
    ].map(({ seq, price, lot }) =>
      ajaibTradeToday({
        seq: base + seq,
        time,
        ticker: code,
        price,
        lot,
        type: "SELL",
      })
    ),
  ])
  await closedOnceStored(page, relay, code, 19)
  // XL's trade has no codes yet.
  await storeCodes(page, [[base + 1, "AK F FZ D"]])

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(
    `${DASHBOARD}${PAGE}?code=${code}&day=${WibDate.make(wibToday())}`
  )
  const log = page.getByRole("region", { name: "Sweep log" })
  const rows = log.locator("[data-sweep-id]")
  const candles = page.locator('[data-chart="candles"]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("19 @ 500→470")
  // Pinned on the whole sweep's bubble, before its codes land.
  await rows.first().click()
  const whole = await ringedBubble(candles, String(base + 1))
  await page.mouse.click(whole.x, whole.y)
  const tip = page.getByRole("tooltip", { name: "Sweep brokers" })
  await expect(tip).toContainText("Brokers show once every trade")

  // FZ's piece keeps the whole sweep's id, at its own average price.
  await storeCodes(page, [[base + 2, "CC D XL D"]])
  await expect(log).toContainText("2 sweeps · Buy 0 · Sell 2", {
    timeout: 40_000,
  })
  await expect(tip).toContainText("Sell 10 lots @ 500")
  // The pin sits on FZ's bubble, where a fresh click on it pins it, give
  // or take the click's whole pixels.
  const moved = (await tip.boundingBox())!
  const piece = await ringedBubble(candles, String(base + 1))
  expect(Math.abs(piece.y - whole.y)).toBeGreaterThan(5)
  await page.mouse.click(piece.x, piece.y)
  await expect(tip).toContainText("Sell 10 lots @ 500")
  const fresh = (await tip.boundingBox())!
  expect(Math.abs(fresh.x - moved.x)).toBeLessThan(1.5)
  expect(Math.abs(fresh.y - moved.y)).toBeLessThan(1.5)
})

test("a recorded day's Auction row shows its lead buyer and seller, and a broker that bought in it keeps it", async ({
  page,
}) => {
  const relay = await openIngest()
  const earlier = freshTradeNumbers()
  const base = earlier + 1_000
  const code = freshCode("SA")
  // Decision: the auction match is stamped in pre-opening, which makes its
  // prints sideless, but not at 08:58, where market-live.spec.ts counts the
  // opening match's fold. It is numbered below every other spec's trades,
  // all stamped later, so the day store's search on trade numbers
  // (`highestWithin`, tape.ts) reads its minute.
  const auction = Math.floor(earlier / 1_000)
  // As the test above: the sweep stamped now, above another code's trades.
  const time = wibTime(marketNow())
  const earlierCode = freshCode("SE")
  await relay.sendAjaib([
    // The match: AK bought 20 and 5 lots, BK 10; CC sold 30, KZ 5.
    ...[20, 10, 5].map((lot, index) =>
      ajaibTradeToday({
        seq: auction + index + 1,
        time: "08:50:00",
        ticker: code,
        price: 500,
        lot,
      })
    ),
    ...[1, 600].map((seq) =>
      ajaibTradeToday({
        seq: earlier + seq,
        time,
        ticker: earlierCode,
        price: 500,
        lot: 1,
      })
    ),
    // AK's buy sweep of 40 lots.
    ajaibTradeToday({
      seq: base + 1,
      time,
      ticker: code,
      price: 510,
      lot: 40,
      type: "BUY",
    }),
  ])
  await closedOnceStored(page, relay, code, 75)
  await storeCodes(page, [
    [auction + 1, "AK F CC D"],
    [auction + 2, "BK D CC D"],
    [auction + 3, "AK F KZ F"],
    [base + 1, "AK F ZP D"],
  ])

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(
    `${DASHBOARD}${PAGE}?code=${code}&day=${WibDate.make(wibToday())}`
  )
  const log = page.getByRole("region", { name: "Sweep log" })
  const rows = log.locator("[data-sweep-id]")
  await expect(rows).toHaveCount(2)
  const auctionRow = log.locator('[data-side="none"]')
  await expect(auctionRow).toContainText("Auction")
  // The lead buyer in the Buyer column, the lead seller in Seller.
  await expect(auctionRow.locator('[data-column="buyer"]')).toHaveText(
    "AK [F] +1"
  )
  await expect(auctionRow.locator('[data-column="seller"]')).toHaveText(
    "CC [D] +1"
  )
  const tip = page.getByRole("tooltip", { name: "Sweep brokers" })
  await auctionRow.getByText("CC [D]").hover()
  await expect(tip).toContainText("Auction 35 lots @ 500 · 3 trades")
  await expect(tip.getByRole("row")).toHaveText([
    "Buyers",
    /^AK \[F\]\s*25$/,
    /^BK \[D\]\s*10$/,
    "Sellers",
    /^CC \[D\]\s*30$/,
    /^KZ \[F\]\s*5$/,
  ])
  await page.mouse.move(0, 0)

  // The dropdown ranks AK by its sweep alone, not its auction lots; picked,
  // AK keeps the Auction row at what it bought, of the whole.
  const filter = log.getByLabel("Broker filter")
  await expect(filter.getByRole("option")).toHaveText([
    "All brokers",
    "AK [F] · 40",
  ])
  await filter.selectOption("AK")
  await expect(rows).toHaveCount(2)
  await expect(auctionRow).toContainText("25/35 @ 500")
})

// The ringed bubble's centre in the viewport, once it is `id`'s and a
// redraw no longer moves it (a selection can pan the candle chart a frame
// later). The candle chart sits below the footprint chart, so a bubble near
// its foot can fall below a 1080 px viewport until it scrolls into view.
async function ringedBubble(candles: Locator, id: string) {
  await expect(candles).toHaveAttribute("data-ringed-sweep", id)
  await candles.scrollIntoViewIfNeeded()
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
