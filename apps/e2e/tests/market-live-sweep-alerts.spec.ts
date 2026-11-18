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

test("a sweep that reaches its code's top-1% cutoff marks its rows on the live tape, though another code is selected", async ({
  page,
}) => {
  const relay = await openIngest()
  const base = freshTradeNumbers()
  // A code of its own: today's object ranks every code's sweeps all day.
  const code = freshCode("SL")
  await page.goto(`${DASHBOARD}${PAGE}`)
  const tape = page.getByRole("region", { name: "Running trades" })
  const row = (seq: number) =>
    tape.locator(`tr[data-trade-number="${base + seq}"]`)
  // A live alert reaches only an open socket: another code's trade shows
  // first, so the page is live before the sweeps go out.
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 1_000,
      time: wibTime(marketNow()),
      ticker: freshCode("SQ"),
      price: 500,
      lot: 1,
    }),
  ])
  await expect(row(1_000)).toBeVisible()

  // Three seconds in a row on the market clock: the warm-up's, the big
  // sweep's, and a later trade's, which closes the big sweep's second.
  const now = marketNow()
  const [warmAt, bigAt, laterAt] = [now - 2_000, now - 1_000, now].map(wibTime)
  // 100 one-lot sweeps a side: alternate sides, so each trade is a sweep.
  const warm = Array.from({ length: 200 }, (_, index) =>
    ajaibTradeToday({
      seq: base + index + 1,
      time: warmAt!,
      ticker: code,
      price: 500,
      lot: 1,
      type: index % 2 === 0 ? "BUY" : "SELL",
    })
  )
  // A buy sweep of two trades: 30 lots against a cutoff of 1.
  const big = [201, 202].map((seq) =>
    ajaibTradeToday({
      seq: base + seq,
      time: bigAt!,
      ticker: code,
      price: 505,
      lot: 15,
      type: "BUY",
    })
  )
  const later = ajaibTradeToday({
    seq: base + 203,
    time: laterAt!,
    ticker: code,
    price: 500,
    lot: 1,
    type: "SELL",
  })
  await relay.sendAjaib([...warm, ...big, later])

  for (const seq of [201, 202]) {
    await expect(row(seq)).toHaveAttribute("data-sweep-alert", "buy")
    const mark = row(seq).locator("td").first().locator("[data-sweep-alert]")
    await expect(mark).toHaveText("▲")
    await expect(mark).toHaveClass(/text-up/)
  }
  // The warm-up's last sweeps alert nothing: each had 99 earlier.
  for (const seq of [199, 200])
    await expect(row(seq)).not.toHaveAttribute("data-sweep-alert")
  relay.close()
})
