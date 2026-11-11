// Seam (b) of spec apinrdw/kumora#138, the order book: the selected code's
// book reaches the page as an IDX ladder, Ajaib's as the fallback while
// Stockbit has none, then Stockbit's once it sends one.
import { MEMBER, DASHBOARD } from "../support/accounts"
import { marketNow } from "../support/clock"
import { freshCode, openIngest } from "../support/ingest"
import { stockbitOrderBookFrame } from "../support/stockbit"
import { expect, test } from "../support/test"

test.use({ storageState: MEMBER.storageState })

test("the selected code's order book appears, Ajaib's as the fallback, then Stockbit's", async ({
  page,
}) => {
  // A code of its own: today's trading-day object keeps every code's last
  // book, from earlier runs too.
  const code = freshCode("OB")
  const relay = await openIngest()
  await relay.sendAjaib([
    JSON.stringify({
      ticker: code,
      is_initial: "true",
      buy: [
        { num: 0, price: 1010, lot: 0 },
        { num: 12, price: 1000, lot: 340 },
        { num: 7, price: 995, lot: 120 },
      ],
      sell: [
        { num: 4, price: 1005, lot: 90 },
        { num: 9, price: 1010, lot: 610 },
      ],
      updateTime: marketNow(),
    }),
  ])

  await page.goto(`${DASHBOARD}/market-live?code=${code}`)
  const book = page.getByRole("region", { name: "Order book" })
  await expect(book.getByText("Ajaib (fallback)")).toBeVisible()
  const best = book.getByRole("row").nth(1)
  await expect(best.getByRole("cell")).toHaveText([
    "12",
    "340",
    "1,000",
    "1,005",
    "90",
    "4",
  ])
  await expect(book.getByRole("meter", { name: "Bid share" })).toHaveAttribute(
    "aria-valuenow",
    // 460 of 1,160 lots.
    "40"
  )
  await expect(
    book.getByRole("img", { name: "Cumulative depth, 20 levels a side" })
  ).toBeVisible()

  await relay.sendStockbit([
    stockbitOrderBookFrame(code, "BID", [[1000, 15, 400]]),
    stockbitOrderBookFrame(code, "OFFER", [[1005, 3, 50]]),
  ])
  await expect(book.getByText("Stockbit", { exact: true })).toBeVisible()
  await expect(best.getByRole("cell")).toHaveText([
    "15",
    "400",
    "1,000",
    "1,005",
    "50",
    "3",
  ])
  relay.close()
})
