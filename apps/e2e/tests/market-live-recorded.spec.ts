// Recorded day loads on the Test stage (spec apinrdw/kumora#138, "Recorded
// day loads"): what the relay sends lands in today's trading-day object's
// SQLite store at the flush its close runs, and the gated GETs read it back.
// The page that replays a recorded day is apinrdw/kumora#152's.
import { request as requests } from "@playwright/test"
import {
  StockCode,
  WibDate,
  bookAt,
  decodeBookChunk,
  decodeRecordedCandles,
  decodeRecordedTape,
  recordedDayPath,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { MERGE_WINDOW, marketNow, untilMarketTime } from "../support/clock"
import {
  ajaibTradeToday,
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
  const code = StockCode.make(`RD${Date.now().toString(36).toUpperCase()}`)
  const day = WibDate.make(wibToday())
  const sentAt = marketNow()
  const wibTime = new Date(sentAt + 7 * 3_600_000).toISOString().slice(11, 19)
  const relay = await openIngest()
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 1,
      time: wibTime,
      ticker: code,
      price: 500,
      lot: 3,
    }),
  ])
  await relay.sendStockbit([
    stockbitOrderBookFrame(code, "BID", [[500, 4, 120]]),
    stockbitOrderBookFrame(code, "OFFER", [[505, 2, 60]]),
  ])
  // The relay closing flushes at once every book chunk whose market-clock
  // minute is over (book-chunks.ts) and every trade out of its 5 s merge
  // window (candles.ts), so it closes once both are, rather than waiting for
  // the next minute's flush.
  const minuteOver = (Math.floor(sentAt / 60_000) + 1) * 60_000
  await page.waitForTimeout(
    untilMarketTime(Math.max(minuteOver, sentAt + MERGE_WINDOW))
  )
  relay.close()

  const bookUrl = urlOf(
    recordedDayPath(day, {
      _tag: "Book",
      code,
      minute: DateTime.makeUnsafe(sentAt),
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
  const book = Effect.runSync(
    bookAt(chunk, DateTime.makeUnsafe(sentAt + 60_000))
  )
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
