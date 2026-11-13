import {
  BrokerCodesProtocolVersion,
  StockCode,
  TradeNumber,
  WibDate,
  isTradingDay,
  type BrokerCodesStatus,
} from "@workspace/relay"
import type { Worker } from "@playwright/test"
import { DateTime, Effect } from "effect"

import { MEMBER } from "../support/accounts"
import {
  AJAIB_TAB,
  AJAIB_USER_ID,
  PIN_ANSWERS,
  SESSION_1,
  STOCKBIT_TAB,
  STOCKBIT_TOKEN,
  TICKS,
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

    // The fake page's own REST call carries no token, so the PIN sign-in
    // names the account.
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

// The two newest trading days closed now, newest first: the broker codes
// walks run on the real clock, not the relay's schedule clock.
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
  sources: { ajaib: 990, stockbit: 10 },
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
          sources: { ajaib: 990, stockbit: 0 },
        }
      : brokers.production.statuses(day)
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
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
      `${newest}6 missingStockbitno cross-check`
    )
    await expect(days.locator(`tr[data-day="${before}"]`)).toHaveText(
      `${before}CompleteAjaib and StockbitmatchesBehind`
    )

    // A walk in progress, the History position and an Ajaib lock, as the
    // worker writes them. The lock shows on the badge.
    await worker.evaluate(`Promise.all([
      chrome.storage.session.set({ brokerCodesProgress: {
        state: "walking", walk: "history", day: "2026-10-02", feed: "Stockbit",
        trades: { fetched: 460000, of: 1000000, perSecond: 300 } } }),
      chrome.storage.session.set({ ajaibLock: { state: "locked", reason: "no-pin" } }),
      chrome.storage.local.set({ brokerCodesHistory: { oldest: "2026-10-05", empty: 0, ended: false } }),
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

    // Resume runs the queue again: with no broker tab, it stops on that, or
    // on Streaming hours.
    await options.getByRole("button", { name: "Resume" }).click()
    await expect
      .poll(() => stored(worker, "local", "brokerCodesPaused"))
      .toBe(false)
    await expect(causes).toContainText(/No broker tab|Streaming hours/)
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
    await worker.evaluate(
      `chrome.storage.session.set({ brokerCodesThrottled: { Stockbit: ${until} } })`
    )
    await expect(causes).toContainText("Stockbit throttled until")
    await options.clock.fastForward(6_000)
    await expect(causes).not.toContainText("Stockbit throttled")
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
      `${newest}6 missingStockbitno cross-check`
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
