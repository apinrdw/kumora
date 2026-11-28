import {
  BrokerCodesProtocolVersion,
  StockCode,
  TradeNumber,
  WibDate,
  decodeBrokerCodesBatch,
  isTradingDay,
  type BrokerCodesStatus,
} from "@workspace/relay"
import type { Worker } from "@playwright/test"
import { DateTime, Effect } from "effect"
import { readFileSync } from "node:fs"

import { MEMBER } from "../support/accounts"
import {
  AJAIB_DEVICE_SIGNATURE,
  AJAIB_PAGE_TOKEN,
  AJAIB_STATIC_HEADERS,
  AJAIB_TAB,
  AJAIB_USER_ID,
  PIN_ANSWERS,
  SESSION_1,
  STOCKBIT_TAB,
  STOCKBIT_TOKEN,
  TICKS,
  WORKER_CONSOLE,
  launchWithExtension,
  sent,
  setRelayClock,
  startFakeBrokers,
  startFakeIngest,
  tickRelay,
} from "../support/relay-extension"
import { expect, test } from "../support/test"

// The relay-extension tests that need only a fake ingest server, never the
// trading-day object; the one that relays to the real dashboard lives in
// market-live-relay-extension.spec.ts.

// Waits until the Ajaib tab just opened is attached: the tab attaches on a
// browser event, not on a tick, so this ticks the relay until a tick's code
// list GET shows it ran with the tab. That tick also tried any PIN entered.
const ajaibAttached = (
  worker: Worker,
  brokers: Awaited<ReturnType<typeof startFakeBrokers>>
) =>
  expect
    .poll(async () => {
      await tickRelay(worker)
      return brokers.requests.some(
        (request) => request.path === "/api/v1/stock/data/list/"
      )
    })
    .toBe(true)

test.use({ storageState: MEMBER.storageState })

const ON_DEMAND = {
  "/ws/price": "PRICE",
  "/ws/indicative": "INDICATIVE",
  "/ws/order-book-custom": "ORDER_BOOK_CUSTOM",
} as const

const onDemand = (
  method: "SUBSCRIBE" | "UNSUBSCRIBE",
  stream: string,
  code: string
) => JSON.stringify({ method, stream, streamObject: code })

test("the relay streams only in IDX hours and subscribes Ajaib's on-demand codes", async () => {
  test.setTimeout(150_000)
  const brokers = await startFakeBrokers()
  const ingest = await startFakeIngest()
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    await setRelayClock(worker, "2026-11-10T07:00:00")
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.getByLabel("Extra target URL").fill(ingest.origin)
    await options.getByLabel("Extra target ingest token").fill("any")
    await options.getByRole("button", { name: "Save" }).click()
    await expect.poll(() => ingest.sockets.length).toBe(1)

    // Before 08:40 an open Ajaib tab gets no sockets: its code list fetch
    // shows a tick ran with the tab, and the ticks after it open nothing.
    const ajaibTab = await context.newPage()
    await ajaibTab.goto(AJAIB_TAB)
    await ajaibAttached(worker, brokers)
    await tickRelay(worker, 3)
    expect(brokers.sockets).toEqual([])

    // In session 1 every Ajaib stream opens.
    await setRelayClock(worker, SESSION_1)
    for (const path of Object.keys(ON_DEMAND))
      await expect.poll(() => brokers.on(path).length).toBe(1)

    // The on-demand codes the trading-day object sends down are subscribed
    // once each, and a change sends only the difference.
    await ingest.sendDown({
      _tag: "OnDemandCodes",
      codes: [StockCode.make("BBCA")],
    })
    for (const [path, stream] of Object.entries(ON_DEMAND))
      await expect
        .poll(() => sent(brokers.on(path)[0]))
        .toEqual([onDemand("SUBSCRIBE", stream, "BBCA")])
    await ingest.sendDown({
      _tag: "OnDemandCodes",
      codes: [StockCode.make("TLKM")],
    })
    await expect
      .poll(() => sent(brokers.on("/ws/price")[0]))
      .toEqual([
        onDemand("SUBSCRIBE", "PRICE", "BBCA"),
        onDemand("UNSUBSCRIBE", "PRICE", "BBCA"),
        onDemand("SUBSCRIBE", "PRICE", "TLKM"),
      ])

    // At 16:35 every socket closes.
    await setRelayClock(worker, "2026-11-10T16:35:00")
    await expect
      .poll(() =>
        brokers.sockets.every((socket) => socket.socket.readyState === 3)
      )
      .toBe(true)
  } finally {
    await context.close()
    await ingest.close()
    await brokers.close()
  }
})

test("a PIN from the options page signs in to Ajaib once, and Ajaib's frames carry the account id", async () => {
  test.setTimeout(150_000)
  const brokers = await startFakeBrokers()
  const ingest = await startFakeIngest()
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    await setRelayClock(worker, SESSION_1)
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.getByLabel("Extra target URL").fill(ingest.origin)
    await options.getByLabel("Extra target ingest token").fill("any")
    await options.getByRole("button", { name: "Save" }).click()
    await expect.poll(() => ingest.sockets.length).toBe(1)
    const state = options.getByLabel("Ajaib sign-in state")
    await expect(state).toContainText("No PIN entered")

    await options.getByLabel("Ajaib PIN").fill("123456")
    await options.getByRole("button", { name: "Sign in" }).click()
    await expect(state).toContainText("tried once when an Ajaib tab is open")
    // The PIN stays in this browser session only.
    expect(
      await worker.evaluate(
        "chrome.storage.local.get(null).then((all) => JSON.stringify(all))"
      )
    ).not.toContain("123456")

    // The fake page's own REST call carries a token that names no account,
    // so the PIN sign-in names it.
    const ajaibTab = await context.newPage()
    await ajaibTab.goto(AJAIB_TAB)
    await ajaibAttached(worker, brokers)
    await expect(state).toHaveText("Signed in.")
    expect(brokers.pin.bodies).toEqual(['{"pin_code":"123456"}'])
    await expect.poll(() => brokers.on("/ws/price").length).toBe(1)
    await ingest.sendDown({
      _tag: "OnDemandCodes",
      codes: [StockCode.make("BBCA")],
    })
    await expect
      .poll(() => sent(brokers.on("/ws/price")[0]))
      .toEqual([
        JSON.stringify({
          method: "SUBSCRIBE",
          id: AJAIB_USER_ID,
          stream: "PRICE",
          streamObject: "BBCA",
        }),
      ])

    // A refused PIN is tried once and never again, and is gone from the
    // session.
    brokers.pin.answer = PIN_ANSWERS.refused
    await options.getByLabel("Ajaib PIN").fill("111111")
    await options.getByRole("button", { name: "Sign in" }).click()
    await expect(state).toContainText("tried once when an Ajaib tab is open")
    await tickRelay(worker)
    expect(brokers.pin.bodies).toHaveLength(2)
    await expect(state).toContainText("Ajaib refused the PIN")
    await tickRelay(worker, 3)
    expect(brokers.pin.bodies).toEqual([
      '{"pin_code":"123456"}',
      '{"pin_code":"111111"}',
    ])
    expect(
      await worker.evaluate(
        "chrome.storage.session.get(null).then((all) => JSON.stringify(all))"
      )
    ).not.toContain("111111")
  } finally {
    await context.close()
    await ingest.close()
    await brokers.close()
  }
})

// Stockbit's REST rows for these numbers, as its tape answers them.
const stockbitRows = (numbers: ReadonlyArray<number>) =>
  numbers.map((number) => ({
    time: "10:00:00",
    action: "buy",
    code: "BBRI",
    price: "2,840",
    lot: "1",
    trade_number: String(number),
    market_board: "RG",
  }))

test("the relay fills a requested gap from Stockbit's REST tape, and what Stockbit lacks from Ajaib's", async () => {
  test.setTimeout(120_000)
  const brokers = await startFakeBrokers()
  const ingest = await startFakeIngest()
  // Stockbit's page before 22331 skips 22326; Ajaib's tape has it.
  brokers.tapes.stockbit = (query) => ({
    data: {
      running_trade:
        query.get("trade_number") === "22331"
          ? stockbitRows([
              22330, 22329, 22328, 22327, 22325, 22324, 22323, 22322, 22321,
            ])
          : [],
    },
  })
  brokers.tapes.ajaib = () => ({
    results: [{ trade_num: "202611100000022326", stock_code: "TINS" }],
    has_next: false,
  })
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    await setRelayClock(worker, SESSION_1)
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.getByLabel("Extra target URL").fill(ingest.origin)
    await options.getByLabel("Extra target ingest token").fill("any")
    await options.getByRole("button", { name: "Save" }).click()
    await expect.poll(() => ingest.sockets.length).toBe(1)
    const stockbitTab = await context.newPage()
    await stockbitTab.goto(STOCKBIT_TAB)
    const ajaibTab = await context.newPage()
    await ajaibTab.goto(AJAIB_TAB)
    await expect.poll(() => brokers.on("/ws/trade").length, TICKS).toBe(1)

    // Trade 22331 happened 3 minutes ago, so Ajaib's tape has caught up.
    const nextTime = Date.now() - 180_000
    await ingest.sendDown({
      _tag: "Backfill",
      from: TradeNumber.make("22322"),
      to: TradeNumber.make("22330"),
      nextTime: DateTime.makeUnsafe(nextTime),
    })
    await expect
      .poll(async () =>
        (await ingest.backfillPages()).map((page) => [
          page.feed,
          page.from,
          page.to,
        ])
      )
      .toEqual([
        ["Stockbit", "22322", "22330"],
        ["Ajaib", "22326", "22326"],
      ])

    // Stockbit was paged by trade number with the tab's token; Ajaib by time
    // with the page's own headers. Both bodies went up as they came.
    // The CORS preflight before it carries no token.
    const stockbitCall = brokers.requests.find(
      (request) =>
        request.path.startsWith("/order-trade/running-trade") &&
        request.headers.authorization !== undefined
    )!
    expect(stockbitCall.path).toBe(
      "/order-trade/running-trade?sort=DESC&order_by=RUNNING_TRADE_ORDER_BY_TIME&limit=100&trade_number=22331"
    )
    expect(stockbitCall.headers.authorization).toBe(`Bearer ${STOCKBIT_TOKEN}`)
    const ajaibCall = brokers.requests.find((request) =>
      request.path.startsWith("/api/v1/stock/detail/running_trades/")
    )!
    expect(ajaibCall.path).toBe(
      `/api/v1/stock/detail/running_trades/?direction=DESC&last_timestamp=${nextTime + 1000}&page=1&page_size=40`
    )
    expect(ajaibCall.headers["x-fake-ajaib-page"]).toBe("yes")
    const [stockbitPage, ajaibPage] = await ingest.backfillPages()
    expect(JSON.parse(stockbitPage!.body)).toEqual(
      brokers.tapes.stockbit(new URLSearchParams("trade_number=22331"))
    )
    expect(JSON.parse(ajaibPage!.body).results[0].stock_code).toBe("TINS")
  } finally {
    await context.close()
    await ingest.close()
    await brokers.close()
  }
})

// The two newest trading days closed now, newest first: the options page's
// last 10 days follow the real clock, not the relay's schedule clock.
const newestClosedDays = () =>
  Effect.runSync(
    Effect.gen(function* () {
      const wib = new Date(Date.now() + 7 * 3_600_000).toISOString()
      const today = Date.parse(wib.slice(0, 10))
      const days: Array<WibDate> = []
      for (
        let back = wib.slice(11, 19) >= "16:35:00" ? 0 : 1;
        days.length < 2;
        back++
      ) {
        const day = WibDate.make(
          new Date(today - back * 86_400_000).toISOString().slice(0, 10)
        )
        if (yield* isTradingDay(day)) days.push(day)
      }
      return days as [WibDate, WibDate]
    })
  )

const completeDay = (day: WibDate): BrokerCodesStatus => ({
  version: BrokerCodesProtocolVersion,
  day,
  n: TradeNumber.make("1000"),
  complete: true,
  missing: [],
  missingCount: 0,
  sources: { ajaib: 990, stockbit: 10 },
  orderNumbers: { ajaib: 0, stockbit: 0, differences: 0 },
  crossCheck: { state: "compared", covered: 1000, differences: 0 },
})

// Reads a key of the worker's chrome.storage area.
const stored = (worker: Worker, area: "local" | "session", key: string) =>
  worker.evaluate(
    `chrome.storage.${area}.get("${key}").then((all) => all.${key} ?? null)`
  )

test("the options page shows the broker codes walks, and Pause and Run now steer them", async () => {
  test.setTimeout(120_000)
  const brokers = await startFakeBrokers()
  const ingest = await startFakeIngest()
  const [newest, before] = newestClosedDays()
  // Production lacks 6 trades of the newest day, which only Stockbit gave
  // and nothing has cross-checked; the extra target lacks 10 of the day
  // before.
  brokers.production.statuses = (day) =>
    day === newest
      ? {
          ...completeDay(day),
          complete: false,
          missing: [[TradeNumber.make("5"), TradeNumber.make("10")]],
          missingCount: 6,
          sources: { ajaib: 0, stockbit: 994 },
          crossCheck: { state: "none" },
        }
      : completeDay(day)
  ingest.brokerCodes.statuses = (day) =>
    day === before
      ? {
          ...completeDay(day),
          complete: false,
          missing: [[TradeNumber.make("1"), TradeNumber.make("10")]],
          missingCount: 10,
          sources: { ajaib: 990, stockbit: 0 },
        }
      : brokers.production.statuses(day)
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    // The queue reads the relay's schedule clock, held in session 1 so that
    // what a run stops on doesn't follow the real hour.
    await setRelayClock(worker, SESSION_1)
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.getByLabel("Production ingest token").fill("any")
    await options.getByLabel("Extra target URL").fill(ingest.origin)
    await options.getByLabel("Extra target ingest token").fill("any")
    await options.getByRole("button", { name: "Save" }).click()
    await expect(options.getByLabel("Production state")).toHaveText("Connected")
    const causes = options.getByLabel("Broker codes pause causes")

    // Pause is kept in local storage, and the queue stops on it.
    await options.getByRole("button", { name: "Pause" }).click()
    await expect
      .poll(() => stored(worker, "local", "brokerCodesPaused"))
      .toBe(true)
    await expect
      .poll(() => stored(worker, "session", "brokerCodesProgress"))
      .toEqual({ state: "paused", cause: "paused" })
    await expect(causes).toContainText("Paused by the owner.")
    await expect(
      options.getByRole("button", { name: "Run now" })
    ).toBeDisabled()

    // The last 10 trading days, from the statuses.
    await options.reload()
    const days = options.getByRole("table", { name: "Last 10 trading days" })
    await expect(days.locator("tbody tr")).toHaveCount(10)
    await expect(days.locator(`tr[data-day="${newest}"]`)).toHaveText(
      `${newest}6 missing5–10Stockbitno cross-check`
    )
    await expect(days.locator(`tr[data-day="${before}"]`)).toHaveText(
      `${before}CompleteAjaib and StockbitmatchesBehind`
    )
    const missing = days.getByLabel(`Missing trades on ${newest}`)
    await expect(missing).toBeHidden()
    await days.getByText("6 missing").click()
    await expect(missing).toHaveText("5–10")

    // A walk in progress, the History position and an Ajaib lock, as the
    // worker writes them. The lock shows on the badge.
    await worker.evaluate(`Promise.all([
      chrome.storage.session.set({ brokerCodesProgress: {
        state: "walking", walk: "history", day: "2026-10-02", feed: "Stockbit",
        trades: { fetched: 460000, of: 1000000, perSecond: 300 } } }),
      chrome.storage.session.set({ ajaibLock: { state: "locked", reason: "no-pin" } }),
      chrome.storage.local.set({ brokerCodesHistoryTrades: { oldest: "2026-10-05", empty: 0, ended: false } }),
    ])`)
    await expect(options.getByLabel("Broker codes walk")).toHaveText(
      "Stockbit, 2026-10-02 (History)"
    )
    await expect(options.getByLabel("Broker codes trades")).toHaveText(
      "460,000 of 1,000,000 trades"
    )
    await expect(options.getByLabel("Broker codes pace")).toHaveText(
      "300 trades/s"
    )
    await expect(options.getByLabel("Broker codes time left")).toHaveText(
      "30 min left"
    )
    await expect(options.getByLabel("History walk")).toHaveText(
      "Running. Oldest day reached: 2026-10-05."
    )
    await expect(causes).toContainText("Ajaib locked: enter the PIN")
    await expect
      .poll(() => worker.evaluate("chrome.action.getBadgeText({})"))
      .toBe("PIN")

    // Resume runs the queue again, and it stops on Streaming hours.
    await options.getByRole("button", { name: "Resume" }).click()
    await expect
      .poll(() => stored(worker, "local", "brokerCodesPaused"))
      .toBe(false)
    await expect(causes).toContainText("Streaming hours")
    await expect(causes).not.toContainText("Paused by the owner.")

    // Run now asks the worker through session storage, and it answers.
    await options.getByRole("button", { name: "Run now" }).click()
    await expect
      .poll(() => stored(worker, "session", "brokerCodesRun"))
      .toBe("started")
  } finally {
    await context.close()
    await ingest.close()
    await brokers.close()
  }
})

// The night after SESSION_1's day closed, on the relay's schedule clock,
// which the broker codes walks also read. Ajaib's window for that day has
// ended by then (ajaibWindowEnd in
// apps/extension/src/worker/broker-codes/hours.ts), so Stockbit's walk takes
// the day.
const NIGHT = "2026-11-11T01:00:00"
const CLOSED_DAY = WibDate.make("2026-11-10")

// Long enough for a queue that Ajaib's walk holds to move on. The worker's
// first tick can come before the test moves its clock, and on a real evening
// that tick starts Ajaib's walk of the real day, which asks for its tab once
// a minute (guard in apps/extension/src/worker/broker-codes/ajaib-walk.ts).
const AJAIB_TAB_POLL = { timeout: 70_000 }

test("Run now with a Stockbit tab open starts a broker codes walk, at any hour, posting its trades' order numbers", async () => {
  test.setTimeout(120_000)
  const brokers = await startFakeBrokers()
  // Production holds nothing of the closed day yet.
  brokers.production.statuses = (day) =>
    day === CLOSED_DAY
      ? {
          ...completeDay(day),
          n: null,
          complete: false,
          sources: { ajaib: 0, stockbit: 0 },
          crossCheck: { state: "none" },
        }
      : completeDay(day)
  // Stockbit has closed the day, and its tape pages on well past the test,
  // each trade with its codes and its buy and sell order numbers.
  brokers.tapes.stockbit = (query) => {
    const after = Number(query.get("trade_number") ?? 0)
    return {
      data: {
        is_open_market: false,
        running_trade:
          query.get("sort") === "DESC"
            ? [{ trade_number: "1000000" }]
            : Array.from({ length: 100 }, (_, at) => ({
                trade_number: String(after + at + 1),
                buyer: "AK [F]",
                seller: "CC [D]",
                buy_order_number: String(2 * (after + at + 1)),
                sell_order_number: String(2 * (after + at + 1) + 1),
              })),
      },
    }
  }
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    // A tick that night makes its day the one the queue last ticked a run
    // for, so coming back to that night later starts none.
    await setRelayClock(worker, NIGHT)
    await setRelayClock(worker, SESSION_1)
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.getByLabel("Production ingest token").fill("any")
    await options.getByRole("button", { name: "Save" }).click()
    await expect(options.getByLabel("Production state")).toHaveText("Connected")
    const stockbitTab = await context.newPage()
    await stockbitTab.goto(STOCKBIT_TAB)
    await expect.poll(() => brokers.on("/ws").length, TICKS).toBe(1)
    await expect
      .poll(
        () => stored(worker, "session", "brokerCodesProgress"),
        AJAIB_TAB_POLL
      )
      .toEqual({ state: "paused", cause: "streaming-hours" })

    await setRelayClock(worker, NIGHT)
    expect(await stored(worker, "session", "brokerCodesProgress")).toEqual({
      state: "paused",
      cause: "streaming-hours",
    })
    const runNow = options.getByRole("button", { name: "Run now" })
    await runNow.click()
    await expect
      .poll(() => stored(worker, "session", "brokerCodesRun"))
      .toBe("started")
    await expect(runNow).toBeEnabled()
    await expect
      .poll(() => stored(worker, "session", "brokerCodesProgress"))
      .toMatchObject({
        state: "walking",
        walk: "newest",
        day: CLOSED_DAY,
        feed: "Stockbit",
      })
    await expect(options.getByLabel("Broker codes walk")).toHaveText(
      `Stockbit, ${CLOSED_DAY} (newest closed day)`
    )
    // Its batches to Production carry each trade's codes and order numbers.
    const posted = async () => {
      const batches = await Effect.runPromise(
        Effect.forEach(brokers.production.batches, (batch) =>
          decodeBrokerCodesBatch(JSON.stringify(batch))
        )
      )
      return batches.flatMap((batch) => batch.rows)
    }
    await expect.poll(async () => (await posted()).length).toBeGreaterThan(0)
    const [number, codes, fields, orders] = (await posted())[0]!
    expect([codes, fields, orders]).toEqual([
      { buyer: "AK", buyerType: "F", seller: "CC", sellerType: "D" },
      null,
      [2 * Number(number), 2 * Number(number) + 1],
    ])
  } finally {
    await context.close()
    await brokers.close()
  }
})

// The evening of CLOSED_DAY, inside Ajaib's window for it.
const EVENING = "2026-11-10T20:00:00"
const atWib = (time: string) => Date.parse(`${CLOSED_DAY}T${time}+07:00`)

// CLOSED_DAY's tape on Ajaib: HOPE's closing-auction match, two tied HOPE
// trades in one second, and a BBCA trade that Done Details doesn't list.
const AJAIB_TAPE = [
  { number: 1, at: "08:58:00", code: "HOPE", price: 170, lot: 20 },
  { number: 2, at: "10:00:05", code: "HOPE", price: 172, lot: 5 },
  { number: 3, at: "10:00:05", code: "HOPE", price: 172, lot: 5 },
  { number: 4, at: "14:00:00", code: "BBCA", price: 9_000, lot: 1 },
].map((trade) => ({
  stock_code: trade.code,
  trade_num: `20261110${String(trade.number).padStart(10, "0")}`,
  lot: trade.lot,
  price: trade.price,
  side: trade.number === 1 ? "SELL" : "BUY",
  date: CLOSED_DAY,
  timestamp: atWib(trade.at) + trade.number,
  buyer: trade.number === 1 ? "XL" : "CC",
  buyer_type: "D",
  seller: trade.number === 1 ? "MG" : "YP",
  seller_type: "D",
  market_type: "RG",
}))

// Ajaib's tape as probed (ajaib-walk.ts): rows strictly before
// `last_timestamp` floored to 3 minutes, newest first, page p starting at
// (p - 1) × (size + 1).
const ajaibTape = (query: URLSearchParams) => {
  const block = 3 * 60_000
  const floor = Math.floor(Number(query.get("last_timestamp")) / block) * block
  const page = Number(query.get("page"))
  const size = Number(query.get("page_size"))
  const start = (page - 1) * (size + 1)
  return {
    results: AJAIB_TAPE.filter((row) => row.timestamp < floor)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(start, start + size),
  }
}

// HOPE's Done Details rows, newest first as Ajaib answers them: each side's
// order id is the day and its order number. The closing auction's time is
// `HH:mm`.
const detail = (time: string, buy: number, sell: number) => ({
  time,
  code: "HOPE",
  board: "RG",
  price: time === "08:58" ? 170 : 172,
  qty: time === "08:58" ? 20 : 5,
  buyer: {
    type: "D",
    broker_code: time === "08:58" ? "XL" : "CC",
    order_id: `20261110${String(buy).padStart(10, "0")}`,
    is_highlighted: false,
  },
  seller: {
    type: "D",
    broker_code: time === "08:58" ? "MG" : "YP",
    order_id: `20261110${String(sell).padStart(10, "0")}`,
    is_highlighted: true,
  },
})
const HOPE_DETAILS = [
  detail("10:00:05", 2_003, 1_800),
  detail("10:00:05", 2_002, 1_800),
  detail("08:58", 1_000, 1_500),
]

test("after Ajaib's tape walk, its Done Details walk posts the kept trades' order numbers", async () => {
  test.setTimeout(240_000)
  const brokers = await startFakeBrokers()
  brokers.production.statuses = (day) =>
    day === CLOSED_DAY
      ? {
          ...completeDay(day),
          n: null,
          complete: false,
          sources: { ajaib: 0, stockbit: 0 },
          crossCheck: { state: "none" },
        }
      : completeDay(day)
  brokers.tapes.ajaibStatus = () => ({ result: { status: "CLOSED" } })
  brokers.tapes.ajaib = ajaibTape
  brokers.tapes.doneDetails = (query) => ({
    err_code: "EC0000000",
    result: {
      has_next: false,
      transactions: query.get("code") === "HOPE" ? HOPE_DETAILS : [],
    },
  })
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    // A run waits on Production's token, then Session 1 stops whatever run
    // the worker's first tick started.
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.getByLabel("Production ingest token").fill("any")
    await options.getByRole("button", { name: "Save" }).click()
    await expect(options.getByLabel("Production state")).toHaveText("Connected")
    await setRelayClock(worker, SESSION_1)
    await expect
      .poll(
        () => stored(worker, "session", "brokerCodesProgress"),
        AJAIB_TAB_POLL
      )
      .toEqual({ state: "paused", cause: "streaming-hours" })
    const ajaibTab = await context.newPage()
    await ajaibTab.goto(AJAIB_TAB)
    await ajaibAttached(worker, brokers)

    // The evening: CLOSED_DAY is the newest closed day, and its run starts.
    await setRelayClock(worker, EVENING)
    type Row = [string, unknown, unknown?, [number, number]?]
    const rows = () =>
      brokers.production.batches.flatMap(
        (batch) => (batch as { rows: Array<Row> }).rows
      )
    const orders = () =>
      rows().flatMap(([number, , , pair]) =>
        pair === undefined ? [] : [[number, pair] as const]
      )
    await expect
      .poll(() => orders().length, { timeout: 180_000, intervals: [1_000] })
      .toBe(3)

    // The tape walk posted every trade first, then the Done Details walk
    // posted HOPE's three with their order numbers and no fields; BBCA's
    // has none. Each row, newest first, takes the highest-numbered trade
    // left of its key, so the tied trades take their rows newest first.
    expect(
      rows()
        .filter(([, , , pair]) => pair === undefined)
        .map(([number]) => number)
        .sort()
    ).toEqual(["1", "2", "3", "4"])
    const posted = new Map(orders())
    expect(posted.get("1")).toEqual([1_000, 1_500])
    expect(posted.get("2")).toEqual([2_002, 1_800])
    expect(posted.get("3")).toEqual([2_003, 1_800])
    for (const [, codes, fields, pair] of rows())
      if (pair !== undefined) {
        expect(fields).toBeNull()
        expect(codes).toMatchObject({ buyerType: "D", sellerType: "D" })
      }
    expect(
      brokers.requests
        .filter((request) =>
          request.path.startsWith("/api/v1/stock/data/broker-transaction")
        )
        .map((request) => new URL(request.path, AJAIB_TAB).searchParams)
        .map((query) => [query.get("code"), query.get("page")])
    ).toEqual([
      ["BBCA", "1"],
      ["HOPE", "1"],
    ])

    // The options page's line for a Done Details walk, as the worker
    // writes it.
    await worker.evaluate(`chrome.storage.session.set({ brokerCodesProgress: {
      state: "walking", walk: "newest", day: "${CLOSED_DAY}", feed: "Ajaib",
      route: "done-details", stockCodes: { done: 12, of: 900 } } })`)
    await expect(options.getByLabel("Broker codes walk")).toHaveText(
      `Ajaib Done Details, ${CLOSED_DAY} (newest closed day)`
    )
    await expect(options.getByLabel("Broker codes stock codes")).toHaveText(
      "12 of 900 codes"
    )
  } finally {
    await context.close()
    await brokers.close()
  }
})

test("after the Ajaib tab reloads and its page makes no call, a walk call still carries the page's static headers", async () => {
  test.setTimeout(240_000)
  const brokers = await startFakeBrokers()
  brokers.production.statuses = (day) =>
    day === CLOSED_DAY
      ? {
          ...completeDay(day),
          n: null,
          complete: false,
          sources: { ajaib: 0, stockbit: 0 },
          crossCheck: { state: "none" },
        }
      : completeDay(day)
  brokers.tapes.ajaibStatus = () => ({ result: { status: "CLOSED" } })
  brokers.tapes.ajaib = ajaibTape
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    // The PIN sign-in's token is the walk's once the page holds none.
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.getByLabel("Production ingest token").fill("any")
    await options.getByRole("button", { name: "Save" }).click()
    await expect(options.getByLabel("Production state")).toHaveText("Connected")
    await options.getByLabel("Ajaib PIN").fill("123456")
    await options.getByRole("button", { name: "Sign in" }).click()
    await setRelayClock(worker, SESSION_1)
    await expect
      .poll(
        () => stored(worker, "session", "brokerCodesProgress"),
        AJAIB_TAB_POLL
      )
      .toEqual({ state: "paused", cause: "streaming-hours" })
    const ajaibTab = await context.newPage()
    await ajaibTab.goto(AJAIB_TAB)
    await ajaibAttached(worker, brokers)
    await expect(options.getByLabel("Ajaib sign-in state")).toHaveText(
      "Signed in."
    )

    // After the close the reloaded page drives its data over sockets and
    // makes no REST call of its own.
    brokers.ajaibPage.calls = false
    const reloadedAt = brokers.requests.length
    await ajaibTab.reload()
    await setRelayClock(worker, EVENING)
    const walkCalls = () =>
      brokers.requests
        .slice(reloadedAt)
        .filter((request) =>
          request.path.startsWith("/api/v1/stock/detail/running_trades/")
        )
    await expect
      .poll(() => walkCalls().length, { timeout: 180_000, intervals: [1_000] })
      .toBeGreaterThan(0)

    const [call] = walkCalls()
    expect(call?.headers).toMatchObject({
      ...AJAIB_STATIC_HEADERS,
      authorization: `jwt ${PIN_ANSWERS.approved.result.access_token}`,
    })
    expect(call?.headers).not.toHaveProperty("x-device-signature")
    // Nothing secret is kept.
    const session = await worker.evaluate(
      "chrome.storage.session.get(null).then((all) => JSON.stringify(all))"
    )
    expect(session).not.toContain(AJAIB_PAGE_TOKEN)
    expect(session).not.toContain(AJAIB_DEVICE_SIGNATURE)
  } finally {
    await context.close()
    await brokers.close()
  }
})

test("the options page drops a throttle when it ends, however long the page was open", async () => {
  const brokers = await startFakeBrokers()
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    const options = await context.newPage()
    await options.clock.install()
    await options.goto(optionsUrl)
    const causes = options.getByLabel("Broker codes pause causes")
    // The page has been open a minute when Stockbit throttles for 5 s.
    await options.clock.fastForward("01:00")
    const until = (await options.evaluate(() => Date.now())) + 5_000
    // The key is THROTTLED_PREFIX's, in apps/extension/src/worker/settings.ts.
    await worker.evaluate(
      `chrome.storage.session.set({ "brokerCodesThrottled.Stockbit": ${until} })`
    )
    await expect(causes).toContainText("Stockbit throttled until")
    await options.clock.fastForward(6_000)
    await expect(causes).not.toContainText("Stockbit throttled")
  } finally {
    await context.close()
    await brokers.close()
  }
})

test("the service worker's console lands in the test's output", async () => {
  const brokers = await startFakeBrokers()
  const { worker } = await launchWithExtension(brokers.port)
  try {
    await worker.evaluate(`console.warn("worker console check")`)
    await expect
      .poll(() => readFileSync(test.info().outputPath(WORKER_CONSOLE), "utf8"))
      .toContain("[warning] worker console check\n")
  } finally {
    await brokers.close()
  }
})

test("the options page shows a stopped relay, and copies diagnostics without the PIN or tokens", async () => {
  const brokers = await startFakeBrokers()
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.getByLabel("Production ingest token").fill("prod-token-41")
    await options.getByLabel("Extra target URL").fill("http://127.0.0.1:9")
    await options.getByLabel("Extra target ingest token").fill("extra-token-42")
    await options.getByRole("button", { name: "Save" }).click()
    await expect(options.getByLabel("Production state")).not.toHaveText(
      "Unknown"
    )
    await options.getByLabel("Ajaib PIN").fill("654321")
    await options.getByRole("button", { name: "Sign in" }).click()
    await expect(options.getByLabel("Ajaib sign-in state")).toContainText(
      "PIN saved"
    )
    await expect(options.getByRole("alert")).toHaveCount(0)

    // The keys as the worker's error log and its stopped main loop write them.
    await worker.evaluate(`chrome.storage.session.set({
      relayErrors: [{ at: 1794300000000, level: "Error",
        message: "Code list fetch failed", cause: "Error: no tab" }],
      relayStopped: { at: 1794300001000, cause: "Error: main died" },
      brokerCodesRun: "started",
      brokerCodesProgress: { state: "paused", cause: "no-tab" },
    })`)
    await expect(options.getByLabel("Errors kept")).toHaveText("1")
    await expect(options.getByRole("alert")).toContainText("Relay stopped")
    await expect(options.getByRole("alert")).toContainText(
      "reload the extension"
    )

    await options.getByRole("button", { name: "Copy diagnostics" }).click()
    await expect(options.getByText("Copied.")).toBeVisible()
    const copied = await options.evaluate(() => navigator.clipboard.readText())
    expect(copied).toContain("Kumora relay ")
    expect(copied).toContain("Relay stopped: 2026-11-10T")
    expect(copied).toContain("Error: main died")
    expect(copied).toContain("Error Code list fetch failed\nError: no tab")
    expect(copied).toContain('brokerCodesRun: "started"')
    expect(copied).toMatch(/^brokerCodesProgress: \{.*"state":/m)
    expect(copied).toContain("brokerCodesThrottled.Stockbit: null")
    expect(copied).toContain("ajaibLock: ")
    for (const secret of ["654321", "prod-token-41", "extra-token-42"])
      expect(copied).not.toContain(secret)
  } finally {
    await context.close()
    await brokers.close()
  }
})

test("the options page asks the last 10 days again when the targets change", async () => {
  const brokers = await startFakeBrokers()
  const ingest = await startFakeIngest()
  const [newest, before] = newestClosedDays()
  brokers.production.statuses = (day) =>
    day === newest
      ? {
          ...completeDay(day),
          complete: false,
          missing: [[TradeNumber.make("5"), TradeNumber.make("10")]],
          missingCount: 6,
          sources: { ajaib: 0, stockbit: 994 },
          crossCheck: { state: "none" },
        }
      : completeDay(day)
  ingest.brokerCodes.statuses = (day) =>
    day === before
      ? {
          ...completeDay(day),
          complete: false,
          missing: [[TradeNumber.make("1"), TradeNumber.make("10")]],
          missingCount: 10,
          sources: { ajaib: 990, stockbit: 0 },
        }
      : brokers.production.statuses(day)
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.getByRole("button", { name: "Pause" }).click()
    await expect
      .poll(() => stored(worker, "session", "brokerCodesProgress"))
      .toEqual({ state: "paused", cause: "paused" })
    const days = options.getByRole("table", { name: "Last 10 trading days" })
    await expect(days.locator(`tr[data-day="${newest}"]`)).toHaveText(
      `${newest}Unknown`
    )

    // The walks stay paused, and the rows follow the new targets.
    await options.getByLabel("Production ingest token").fill("any")
    await options.getByLabel("Extra target URL").fill(ingest.origin)
    await options.getByLabel("Extra target ingest token").fill("any")
    await options.getByRole("button", { name: "Save" }).click()
    await expect(days.locator(`tr[data-day="${newest}"]`)).toHaveText(
      `${newest}6 missing5–10Stockbitno cross-check`
    )
    await expect(days.locator(`tr[data-day="${before}"]`)).toHaveText(
      `${before}CompleteAjaib and StockbitmatchesBehind`
    )
  } finally {
    await context.close()
    await ingest.close()
    await brokers.close()
  }
})
