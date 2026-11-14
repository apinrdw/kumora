import { DASHBOARD, MEMBER } from "../support/accounts"
import { marketNow, wibTime } from "../support/clock"
import {
  ajaibTradeToday,
  freshCode,
  freshTradeNumbers,
  openIngest,
} from "../support/ingest"
import { expect, test } from "../support/test"

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
  // by the delta tape.
  await relay.sendAjaib(sweeps.slice(0, 6))
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}`)
  const log = page.getByRole("region", { name: "Sweep log" })
  await expect(log.getByRole("heading")).toHaveText(`Buy/Sell sweeps · ${code}`)
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
  relay.close()
})
