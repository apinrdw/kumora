import {
  INDEX_CODES,
  StockCode,
  TradeNumber,
  decodeIngestUp,
  encodeIngestDown,
  type IngestDown,
} from "@workspace/relay"
import type { Worker } from "@playwright/test"
import { DateTime, Effect } from "effect"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { WebSocketServer, type WebSocket } from "ws"

import { DASHBOARD, MEMBER } from "../support/accounts"
import {
  TEST_INGEST_TOKEN,
  freshTradeNumbers,
  session1Today,
} from "../support/ingest"
import {
  AJAIB_TAB,
  AJAIB_USER_ID,
  PIN_ANSWERS,
  LISTED_CODES,
  STOCKBIT_KEY,
  STOCKBIT_TAB,
  STOCKBIT_TOKEN,
  launchWithExtension,
  setRelayClock,
  startFakeBrokers,
  tickRelay,
  type BrokerSocket,
} from "../support/relay-extension"
import { readSubscribe, stockbitTradeFrameToday } from "../support/stockbit"
import { expect, test } from "../support/test"

const TRADE_SUBSCRIBE =
  '{"method":"SUBSCRIBE","stream":"TRADE","streamObject":"*"}'
const PING = '{"method":"SUBSCRIBE","streamObject":"PING-WEB"}'

// The relay ticks every 10 s, so B, pings and reopens each take up to a tick
// or two. A moved clock ticks it at once (support/relay-extension.ts).
const TICKS = { timeout: 25_000 }

// Ticks the relay until `probe` gives what the poll expects.
const tickUntil = (worker: Worker, probe: () => unknown) =>
  expect.poll(async () => {
    await tickRelay(worker)
    return probe()
  })

// A trading day's session 1 (a Tuesday), for the relay's schedule only.
const SESSION_1 = "2026-11-10T10:00:00"

const subscribes = (socket: BrokerSocket | undefined) =>
  (socket?.received ?? [])
    .filter((message) => typeof message !== "string" && message[0] === 0x0a)
    .map((message) => readSubscribe(message as Uint8Array))

test.use({ storageState: MEMBER.storageState })

test("the built extension relays fake Stockbit and Ajaib tabs to the local trading-day object", async ({
  page,
}) => {
  test.setTimeout(150_000)
  const brokers = await startFakeBrokers()
  const { context, worker, optionsUrl } = await launchWithExtension(
    brokers.port
  )
  try {
    await setRelayClock(worker, SESSION_1)
    // The extra target is the Test stage; Production has no token, so the
    // relay leaves it alone.
    const options = await context.newPage()
    await options.goto(optionsUrl)
    await options.getByLabel("Extra target URL").fill(DASHBOARD)
    await options
      .getByLabel("Extra target ingest token")
      .fill(TEST_INGEST_TOKEN)
    await options.getByRole("button", { name: "Save" }).click()
    await expect(options.getByLabel("Extra target state")).toHaveText(
      "Connected"
    )
    await expect(options.getByLabel("Production state")).toHaveText(
      "Off: no ingest token"
    )

    // The Ajaib tab: its content script opens connection A of the trade
    // stream from the tab.
    const ajaibTab = await context.newPage()
    await ajaibTab.goto(AJAIB_TAB)
    await expect.poll(() => brokers.on("/ws/trade").length, TICKS).toBe(1)
    const a = brokers.on("/ws/trade")[0]!
    await expect.poll(() => sent(a)).toEqual([TRADE_SUBSCRIBE])

    // The code list is fetched with the page's own headers, which Ajaib
    // requires.
    await expect
      .poll(
        () =>
          brokers.requests.some(
            (request) =>
              request.path === "/api/v1/stock/data/list/" &&
              request.headers["x-fake-ajaib-page"] === "yes"
          ),
        TICKS
      )
      .toBe(true)

    // Trades on A reach the trading-day object, and from it the tape.
    const base = freshTradeNumbers()
    for (const frame of session1Today(base).slice(20, 30)) a.socket.send(frame)
    await page.goto(`${DASHBOARD}/market-live`)
    const tape = page.getByRole("region", { name: "Running trades" })
    await expect(
      tape.locator(`tr[data-trade-number="${base + 22323}"]`)
    ).toContainText("BRMS")

    // The Stockbit tab: the socket opens with the `web` subprotocol, the
    // websocket key is fetched with the tab's token, and the channel message
    // carries both and every listed code, and the indices' live prices.
    const stockbitTab = await context.newPage()
    await stockbitTab.goto(STOCKBIT_TAB)
    await expect.poll(() => brokers.on("/ws").length, TICKS).toBe(1)
    const stockbitA = brokers.on("/ws")[0]!
    expect(stockbitA.protocol).toBe("web")
    await expect
      .poll(() => subscribes(stockbitA).at(-1), TICKS)
      .toEqual({
        userId: "4242",
        key: STOCKBIT_KEY,
        accessToken: STOCKBIT_TOKEN,
        orderBook: LISTED_CODES,
        runningTradeBatch: ["*"],
        liveprice: [...LISTED_CODES, ...INDEX_CODES],
        iepiev: LISTED_CODES,
      })

    // Stockbit's protobuf frames reach the trading-day object too.
    stockbitA.socket.send(stockbitTradeFrameToday(base))
    const stockbitTrade = tape.locator(
      `tr[data-trade-number="${base + 26320}"]`
    )
    await expect(stockbitTrade).toContainText("ENRG")
    await expect(
      stockbitTrade.getByRole("img", { name: "Stockbit" })
    ).toBeVisible()

    // B opens one tick after A's first frame, fully subscribed.
    await expect.poll(() => brokers.on("/ws/trade").length, TICKS).toBe(2)
    const b = brokers.on("/ws/trade")[1]!
    await expect.poll(() => b.received[0]).toBe(TRADE_SUBSCRIBE)

    // A quiet A sends PING-WEB on a tick.
    await expect.poll(() => a.received.includes(PING), TICKS).toBe(true)

    // A dropped A reopens at once.
    a.socket.terminate()
    await expect.poll(() => brokers.on("/ws/trade").length, TICKS).toBe(3)
    await expect
      .poll(() => brokers.on("/ws/trade")[2]!.received[0])
      .toBe(TRADE_SUBSCRIBE)
  } finally {
    await context.close()
    await brokers.close()
  }
})

// A fake dashboard's ingest socket for the extra target: it accepts any token,
// keeps what the relay sends up and sends down what the test tells it.
async function startFakeIngest() {
  const server = createServer()
  const sockets: Array<WebSocket> = []
  const received: Array<string> = []
  new WebSocketServer({ server }).on("connection", (socket) => {
    sockets.push(socket)
    socket.on("message", (data) => received.push(String(data)))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sockets,
    /** Every BackfillPage the relay sent up: feed, range and body. */
    backfillPages: () =>
      Effect.runPromise(
        Effect.forEach(received, (text) => Effect.option(decodeIngestUp(text)))
      ).then((messages) =>
        messages.flatMap((message) =>
          message._tag === "Some" && message.value._tag === "BackfillPage"
            ? [message.value]
            : []
        )
      ),
    sendDown: async (message: IngestDown) => {
      const text = await Effect.runPromise(encodeIngestDown(message))
      for (const socket of sockets) socket.send(text)
    },
    close: async () => {
      for (const socket of sockets) socket.terminate()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const ON_DEMAND = {
  "/ws/price": "PRICE",
  "/ws/indicative": "INDICATIVE",
  "/ws/order-book-custom": "ORDER_BOOK_CUSTOM",
} as const

// What a socket received, its pings left out.
const sent = (socket: BrokerSocket | undefined) =>
  (socket?.received ?? []).filter((message) => message !== PING)

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
    await tickUntil(worker, () =>
      brokers.requests.some(
        (request) => request.path === "/api/v1/stock/data/list/"
      )
    ).toBe(true)
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
    await setRelayClock(worker, "2026-11-10T16:34:59")
    await tickUntil(worker, () =>
      brokers.sockets.every((socket) => socket.socket.readyState === 3)
    ).toBe(true)
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
    await tickUntil(worker, () => brokers.pin.bodies.length).toBe(1)
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
    await tickUntil(worker, () => brokers.pin.bodies.length).toBe(2)
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
