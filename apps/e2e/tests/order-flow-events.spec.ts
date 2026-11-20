// Order flow events on the page, spec apinrdw/kumora#605 ("Order flow
// events: on the page"): an Exhaustion's row in the radar's Events feed with
// its ▲E mark, the scanner row's last-event chip, and the row opening Market
// Live with `?code=&event=`, whose Book readout lists it picked.
//
// The code's book goes through the relay to the Test stage's trading-day
// object, so the scanner has its row. An Exhaustion needs six minutes of
// trades, so Playwright adds one to each snapshot instead, as the radar's
// spec adds scanner figures (order-book-radar.spec.ts).
import type { Page } from "@playwright/test"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { freshCode, openIngest } from "../support/ingest"
import { stockbitOrderBookFrame } from "../support/stockbit"
import { expect, test } from "../support/test"

test.use({ storageState: MEMBER.storageState })

type WireEvent = Record<string, unknown> & { code: string; at: number }

// Every snapshot's scanner figures with `code` above the value floor, and
// its order flow events with `code`'s Exhaustion, on the minute before the
// first snapshot's, in the market's and, when selected, the code's.
const withExhaustion = (page: Page, code: string) => {
  let minute: number | undefined
  return page.routeWebSocket(/\/market-live\/live$/, (socket) => {
    const server = socket.connectToServer()
    server.onMessage((message) => {
      if (typeof message !== "string") return socket.send(message)
      const parsed = JSON.parse(message) as {
        _tag: string
        at: number
        selected?: string
        scannerFigures?: Array<[string, ...Array<number | null>]>
        orderFlowEvents?: Array<WireEvent>
        selectedOrderFlowEvents?: Array<WireEvent>
      }
      if (parsed._tag === "Snapshot") {
        const event: WireEvent = {
          kind: "exhaustion",
          code,
          at: (minute ??= Math.floor(parsed.at / 60_000) * 60_000 - 60_000),
          side: "buy",
          price: 1250,
          lots: 900,
          peakLots: 2400,
          ticks: 1,
          widestTicks: 5,
        }
        parsed.orderFlowEvents = [...(parsed.orderFlowEvents ?? []), event]
        if (parsed.selected === code)
          parsed.selectedOrderFlowEvents = [
            ...(parsed.selectedOrderFlowEvents ?? []),
            event,
          ]
        parsed.scannerFigures = [
          ...(parsed.scannerFigures ?? []).filter(([each]) => each !== code),
          [code, null, null, 2e9, 0],
        ]
      }
      socket.send(JSON.stringify(parsed))
    })
  })
}

test("an Exhaustion lists in the radar's feed and chip, and opens on Market Live's readout", async ({
  page,
}) => {
  const code = freshCode("OF")
  const relay = await openIngest()
  await relay.sendStockbit([
    stockbitOrderBookFrame(code, "BID", [[1245, 2, 300]]),
    stockbitOrderBookFrame(code, "OFFER", [[1250, 2, 100]]),
  ])
  await withExhaustion(page, code)
  await page.goto(`${DASHBOARD}/order-book-radar`)
  await page.getByRole("searchbox", { name: "Search" }).fill("OF")

  const item = page
    .getByRole("region", { name: "Events" })
    .getByRole("button", { name: new RegExp(code) })
  await expect(item).toContainText("▲E")
  await expect(item).toContainText("Buying exhaustion at the day's high")
  await expect(item).toContainText(
    "buy-aggressor lots 2,400 → 900 a minute · range 5 → 1 ticks"
  )
  const chip = page
    .getByRole("region", { name: "Bid-heavy" })
    .locator(`[data-code="${code}"]`)
    .getByLabel("Last event")
  await expect(chip.locator("abbr")).toHaveText("▲E")

  await item.click()
  await expect(page).toHaveURL(
    new RegExp(`/market-live\\?code=${code}&event=${code}`)
  )
  const picked = page
    .getByRole("region", { name: "Book readout" })
    .getByRole("region", { name: "Events" })
    .getByRole("button", { name: /Buying exhaustion/ })
  await expect(picked).toHaveAttribute("aria-pressed", "true")
  await expect(picked).toContainText("▲E")
  relay.close()
})
