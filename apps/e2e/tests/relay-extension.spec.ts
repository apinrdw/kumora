import { StockCode, encodeIngestDown, type IngestDown } from "@workspace/relay"
import { Effect } from "effect"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { WebSocketServer, type WebSocket } from "ws"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { TEST_INGEST_TOKEN, session1Today } from "../support/ingest"
import {
  AJAIB_TAB,
  LISTED_CODES,
  STOCKBIT_KEY,
  STOCKBIT_TAB,
  STOCKBIT_TOKEN,
  launchWithExtension,
  setRelayClock,
  startFakeBrokers,
  type BrokerSocket,
} from "../support/relay-extension"
import { readSubscribe, stockbitTradeFrameToday } from "../support/stockbit"
import { expect, test } from "../support/test"

const TRADE_SUBSCRIBE =
  '{"method":"SUBSCRIBE","stream":"TRADE","streamObject":"*"}'
const PING = '{"method":"SUBSCRIBE","streamObject":"PING-WEB"}'

// The relay ticks every 10 s, so B, pings, reopens and a moved clock each take
// up to a tick or two.
const TICKS = { timeout: 25_000 }

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
    for (const frame of session1Today().slice(20, 30)) a.socket.send(frame)
    await page.goto(`${DASHBOARD}/market-live`)
    const tape = page.getByRole("region", { name: "Running trades" })
    await expect(tape.locator('tr[data-trade-number="22323"]')).toContainText(
      "BRMS"
    )

    // The Stockbit tab: the socket opens with the `web` subprotocol, the
    // websocket key is fetched with the tab's token, and the channel message
    // carries both and every listed code.
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
        liveprice: LISTED_CODES,
        iepiev: LISTED_CODES,
      })

    // Stockbit's protobuf frames reach the trading-day object too.
    stockbitA.socket.send(stockbitTradeFrameToday())
    const stockbitTrade = tape.locator('tr[data-trade-number="26320"]')
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

// A fake dashboard's ingest socket for the extra target: it accepts any token
// and sends down what the test tells it.
async function startFakeIngest() {
  const server = createServer()
  const sockets: Array<WebSocket> = []
  new WebSocketServer({ server }).on("connection", (socket) =>
    sockets.push(socket)
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    sockets,
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

    // Before 08:40 an open Ajaib tab gets no sockets.
    const ajaibTab = await context.newPage()
    await ajaibTab.goto(AJAIB_TAB)
    await ajaibTab.waitForTimeout(12_000)
    expect(brokers.sockets).toEqual([])

    // In session 1 every Ajaib stream opens.
    await setRelayClock(worker, SESSION_1)
    for (const path of Object.keys(ON_DEMAND))
      await expect.poll(() => brokers.on(path).length, TICKS).toBe(1)

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
    await expect
      .poll(
        () => brokers.sockets.every((socket) => socket.socket.readyState === 3),
        TICKS
      )
      .toBe(true)
  } finally {
    await context.close()
    await ingest.close()
    await brokers.close()
  }
})
