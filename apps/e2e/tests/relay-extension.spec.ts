import {
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
