// A cold day on Market Live (spec apinrdw/kumora#556, tickets #580 and
// #581): a past day the walks filled, sealed, built, then moved by its own
// alarm chain to the Test stage's local R2, as a day out of the
// 10-trading-day window does, and its object emptied. It replays with its
// tape, candles, sweeps and sweep brokers, answered from R2; its page never
// rechecks its codes, though they stay incomplete; and a reload answers its
// GETs from the browser's cache.
import type { Page } from "@playwright/test"
import {
  BROKER_CODES_AUTH_SCHEME,
  BrokerCode,
  BrokerCodesProtocolVersion,
  DayStripPath,
  type BatchRow,
  type InvestorType,
  type StockCode,
  TradeNumber,
  WibDate,
  decodeDayStrip,
  encodeBrokerCodesBatch,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { DASHBOARD, DASHBOARD_PATH, MEMBER } from "../support/accounts"
import { tradingDaysBeforeToday } from "../support/broker-totals"
import { wibInstant } from "../support/clock"
import { TEST_INGEST_TOKEN, freshCode } from "../support/ingest"
import { expect, test } from "../support/test"

test.use({ storageState: MEMBER.storageState })

const BEARER = {
  authorization: `${BROKER_CODES_AUTH_SCHEME}${TEST_INGEST_TOKEN}`,
}

// The day's last trade number: the walks never read trade N, so its codes
// stay incomplete, though one missing in 1,000 lets it seal and build
// (MISSING_ALLOWANCE in apps/dashboard/src/server/market-live/broker-codes.ts).
const N = 1_000

// `code`'s trades on `day`, 1 to N - 1, with their codes and fields: on the
// regular board, a buy sweep of two trades at 09:01 and a sell sweep of one
// at 09:02; then negotiated trades, one a second from 09:05, which neither
// the candles nor the sweeps count.
const walkRows = (day: WibDate, code: StockCode) => {
  const codes = (text: string) => {
    const [buyer, buyerType, seller, sellerType] = text.split(" ")
    return {
      buyer: BrokerCode.make(buyer ?? ""),
      buyerType: buyerType as InvestorType,
      seller: BrokerCode.make(seller ?? ""),
      sellerType: sellerType as InvestorType,
    }
  }
  const row = (
    n: number,
    at: number,
    price: number,
    lots: number,
    side: "buy" | "sell" | "negotiated",
    text: string
  ): BatchRow => [
    TradeNumber.make(String(n)),
    codes(text),
    {
      time: DateTime.makeUnsafe(at),
      code,
      price,
      lots,
      ...(side === "negotiated"
        ? { board: "NG" as const, side: "none" as const }
        : { board: "RG" as const, side }),
    },
  ]
  const at = (time: string) => wibInstant(`${day}T${time}`)
  return [
    row(1, at("09:01:00"), 500, 10, "buy", "AK F BK D"),
    row(2, at("09:01:00"), 505, 30, "buy", "AK F CC D"),
    row(3, at("09:02:00"), 500, 5, "sell", "YP D KZ F"),
    ...Array.from({ length: N - 4 }, (_, index) =>
      row(
        index + 4,
        at("09:05:00") + index * 1_000,
        500,
        1,
        "negotiated",
        "YP D CC D"
      )
    ),
  ]
}

const stripRow = async (page: Page, day: WibDate) => {
  const strip = await page.request.get(`${DASHBOARD}${DayStripPath}`)
  const { days } = await Effect.runPromise(decodeDayStrip(await strip.text()))
  return days.find((row) => row.day === day)
}

interface DayGet {
  // The path's first segment under the day: `trades`, `candles`, ...
  readonly resource: string
  // The path under the day.
  readonly path: string
  // Whether the browser's cache answered it, not the Worker.
  cached: boolean
  // Whether anything answered it: the dev build's second mount aborts the
  // first mount's GETs, and one aborted before the cache answers has none.
  answered: boolean
}

// Each of the day's GETs the page sends from now on, as Chromium's network
// domain reports them.
const dayGets = async (page: Page, day: WibDate) => {
  const prefix = `${DASHBOARD_PATH}/market-live/days/${day}/`
  const gets: Array<DayGet> = []
  const byId = new Map<string, DayGet>()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Network.enable")
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    const { pathname } = new URL(request.url)
    if (!pathname.startsWith(prefix)) return
    const get = {
      resource: pathname.slice(prefix.length).split("/")[0] ?? "",
      path: pathname.slice(prefix.length),
      cached: false,
      answered: false,
    }
    byId.set(requestId, get)
    gets.push(get)
  })
  cdp.on("Network.requestServedFromCache", ({ requestId }) => {
    const get = byId.get(requestId)
    if (get === undefined) return
    get.cached = true
    get.answered = true
  })
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    const get = byId.get(requestId)
    if (get === undefined) return
    get.answered = true
    if (response.fromDiskCache === true) get.cached = true
  })
  return gets
}

// A cold day's 404 is not kept (cold-days.ts `notStored`): the
// day has no code list, so its codes answer is one, and so is its book, as
// the walks recorded none. Every other answer comes from R2, kept for good.
const NOT_KEPT = new Set(["codes", "books"])

test("a cold day replays, is never rechecked, and reloads from the browser's cache", async ({
  page,
}) => {
  // The page is watched past one 30 s recheck.
  test.setTimeout(120_000)
  // Thirty trading days back: no other spec walks it.
  const day = WibDate.make(tradingDaysBeforeToday(30)[0] ?? "")
  const code = freshCode("CD")
  const posted = await page.request.post(
    `${DASHBOARD}/api/broker-codes/${day}`,
    {
      headers: BEARER,
      data: Effect.runSync(
        encodeBrokerCodesBatch({
          version: BrokerCodesProtocolVersion,
          feed: "Ajaib",
          day,
          rows: walkRows(day, code),
          end: { n: TradeNumber.make(String(N)) },
        })
      ),
    }
  )
  expect(posted.status()).toBe(200)
  // The batch made the day buildable, so it sealed at once and built; out
  // of the window, it then moved to R2 and the strip lists it cold.
  await expect
    .poll(() => stripRow(page, day), { timeout: 60_000 })
    .toMatchObject({ day, trades: N - 1, cold: true })
  // R2 answers: a 404 of the move's own, and an incomplete day's sweep
  // brokers kept for good, which its object never keeps.
  const codesGet = await page.request.get(
    `${DASHBOARD}/market-live/days/${day}/codes`
  )
  expect(codesGet.status()).toBe(404)
  expect(await codesGet.json()).toEqual({
    error: "NotFound",
    message: "Not recorded",
  })

  // The context's routes go (support/test.ts sets the client
  // address and the Turnstile stub through them): Playwright turns the
  // browser's HTTP cache off while any route is set, and this spec reads
  // that cache. It signs in from saved state, so neither is needed.
  await page.context().unrouteAll()
  const gets = await dayGets(page, day)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${DASHBOARD}/market-live?code=${code}&day=${day}`)
  await expect(
    page.getByRole("group", { name: "Market conditions" })
  ).toContainText("RECORDED")
  // Its whole-day candles, the regular board's: 09:01 and 09:02.
  await expect(page.getByText("One-minute candles: 2")).toBeAttached()
  // The tape at the close: the day's last trades, with their codes.
  const tape = page.getByRole("region", { name: "Running trades" })
  const last = tape.locator(`tr[data-trade-number="${N - 1}"]`).locator("td")
  await expect(last.nth(5)).toHaveText("YP [D]")
  await expect(last.nth(6)).toHaveText("CC [D]")
  // The sweeps, newest first, with their lead brokers.
  const log = page.getByRole("region", { name: "Sweep log" })
  const rows = log.locator("[data-sweep-id]")
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText("KZ [F]")
  await expect(rows.nth(1)).toContainText("AK [F]")
  await expect(rows.nth(1)).toContainText("CC [D] +1")
  // Its codes stay incomplete for good: the note promises no update.
  await expect(log.getByText(/^Codes incomplete/)).toHaveText(
    "Codes incomplete: 2 of 2 sweeps have their brokers."
  )

  // The day's codes stay incomplete, yet past the 30 s recheck a hot day
  // would make, the page asked nothing more.
  const codesAnswer = await page.request.get(
    `${DASHBOARD}/market-live/days/${day}/sweep-brokers/${code}`
  )
  expect(await codesAnswer.json()).toMatchObject({ complete: false })
  expect(codesAnswer.headers()["cache-control"]).toBe(
    "private, max-age=31536000, immutable"
  )
  // A late batch is taken and writes nothing.
  const late = await page.request.post(`${DASHBOARD}/api/broker-codes/${day}`, {
    headers: BEARER,
    data: Effect.runSync(
      encodeBrokerCodesBatch({
        version: BrokerCodesProtocolVersion,
        feed: "Ajaib",
        day,
        rows: walkRows(day, code).slice(0, 1),
      })
    ),
  })
  expect(late.status()).toBe(200)
  const loaded = gets.length
  await page.waitForTimeout(35_000)
  expect(gets.slice(loaded)).toEqual([])

  // Reloaded, the browser's copies answer the day's GETs.
  // Reloaded twice, the second read. The dev build mounts the
  // page's effects twice, interrupting the first loads, and an interrupted
  // GET of the selected code's candles, which two loads ask for at once,
  // can leave no copy, so the first reload may ask it again.
  const reload = async () => {
    await page.reload()
    await expect(page.getByText("One-minute candles: 2")).toBeAttached()
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(1)).toContainText("AK [F]")
  }
  await reload()
  const reloadedFrom = gets.length
  await reload()
  const reloaded = gets.slice(reloadedFrom).filter((get) => get.answered)
  expect(new Set(reloaded.map((get) => get.resource))).toEqual(
    new Set([
      "codes",
      "trades",
      "broker-codes",
      "candles",
      "sweeps",
      "sweep-brokers",
      "books",
      "gaps",
      "heatmap",
      "book-events",
      "order-flow-events",
    ])
  )
  expect(
    reloaded.filter((get) => !get.cached && !NOT_KEPT.has(get.resource))
  ).toEqual([])
})
