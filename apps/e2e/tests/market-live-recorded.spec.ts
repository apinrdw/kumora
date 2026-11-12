// Recorded day loads on the Test stage (spec apinrdw/kumora#138, "Recorded
// day loads"): what the relay sends lands in today's trading-day object's
// SQLite store at the flush its close runs, and the gated GETs read it back.
// The page that replays a recorded day is apinrdw/kumora#152's.
import { request as requests } from "@playwright/test"
import {
  WibDate,
  bookAt,
  decodeBookChunk,
  decodeRecordedCandles,
  decodeRecordedTape,
  recordedDayPath,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

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
import { stockbitOrderBookFrame } from "../support/stockbit"
import { expect, test } from "../support/test"

test.use({ storageState: MEMBER.storageState })

const urlOf = (path: Effect.Effect<string>) =>
  `${DASHBOARD}${Effect.runSync(path)}`

test("trades and order books the relay sent are read back from the store after the flush", async ({
  page,
}) => {
  // A book chunk is written once its minute is over: up to a minute's wait.
  test.setTimeout(90_000)
  const base = freshTradeNumbers()
  // A code of its own: today's object keeps every code's candles and books.
  const code = freshCode("RD")
  const day = WibDate.make(wibToday())
  const relay = await openIngest()
  // Decision: the waits below run from when the live page shows the trade and
  // the book, not from `sentAt`: the merge window opens when the object takes
  // the trade (candles.ts) and the book's chunk is the minute the object served
  // its frame in (book-chunks.ts), both after the spec sent them. See
  // apinrdw/kumora#191.
  await page.goto(`${DASHBOARD}/market-live?code=${code}`)
  await expect(
    page
      .getByRole("group", { name: "Market conditions" })
      .getByRole("list", { name: "Feeds" })
  ).toBeVisible()
  const sentAt = marketNow()
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 1,
      time: wibTime(sentAt),
      ticker: code,
      price: 500,
      lot: 3,
    }),
  ])
  await relay.sendStockbit([
    stockbitOrderBookFrame(code, "BID", [[500, 4, 120]]),
    stockbitOrderBookFrame(code, "OFFER", [[505, 2, 60]]),
  ])
  await expect(
    page
      .getByRole("region", { name: "Running trades" })
      .locator(`tr[data-trade-number="${base + 1}"]`)
  ).toBeVisible()
  await expect(
    page
      .getByRole("region", { name: "Order book" })
      .getByText("Stockbit", { exact: true })
  ).toBeVisible()
  const arrivedBy = marketNow()
  // The relay closing flushes at once every book chunk whose market-clock
  // minute is over (book-chunks.ts) and every trade out of its 5 s merge
  // window (candles.ts), so it closes once both are, rather than waiting for
  // the next minute's flush.
  const minuteOver = (Math.floor(arrivedBy / 60_000) + 1) * 60_000
  await page.waitForTimeout(
    untilMarketTime(Math.max(minuteOver, arrivedBy + MERGE_WINDOW))
  )
  relay.close()

  // The chunk is this minute's, or the one before when the frame was served
  // just before the minute turned: the store answers the latest chunk at or
  // before the minute asked for.
  const bookUrl = urlOf(
    recordedDayPath(day, {
      _tag: "Book",
      code,
      minute: DateTime.makeUnsafe(arrivedBy),
    })
  )
  await expect
    .poll(async () => (await page.request.get(bookUrl)).status(), {
      timeout: 15_000,
      intervals: [500],
    })
    .toBe(200)
  const chunk = await Effect.runPromise(
    decodeBookChunk(await (await page.request.get(bookUrl)).text())
  )
  const book = Effect.runSync(bookAt(chunk, DateTime.makeUnsafe(arrivedBy)))
  expect(book?.bids.map((level) => level.lots)).toEqual([120])
  expect(book?.offers.map((level) => level.lots)).toEqual([60])

  const tape = await page.request.get(
    urlOf(
      recordedDayPath(day, {
        _tag: "Tape",
        at: DateTime.makeUnsafe(sentAt + 1_000),
      })
    )
  )
  expect(tape.headers()["cache-control"]).toBe("no-store")
  const { trades } = await Effect.runPromise(
    decodeRecordedTape(await tape.text())
  )
  expect(trades.map((trade) => trade.tradeNumber)).toContain(String(base + 1))

  const candles = await Effect.runPromise(
    decodeRecordedCandles(
      await (
        await page.request.get(
          urlOf(recordedDayPath(day, { _tag: "Candles", code }))
        )
      ).text()
    )
  )
  expect(candles.candles.map((candle) => candle.volume)).toEqual([3])
})

test("a signed-out recorded day GET answers 401 JSON", async () => {
  // Empty on purpose: the test runner hands this file's storageState to
  // every context it opens.
  const signedOut = await requests.newContext({
    storageState: { cookies: [], origins: [] },
  })
  const response = await signedOut.get(
    urlOf(
      recordedDayPath(WibDate.make(wibToday()), {
        _tag: "Tape",
        at: DateTime.makeUnsafe(marketNow()),
      })
    )
  )
  expect(response.status()).toBe(401)
  expect(await response.json()).toMatchObject({ error: "Unauthorized" })
  await signedOut.dispose()
})
