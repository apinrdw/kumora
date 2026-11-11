import { INDEX_CODES } from "@workspace/relay"

import { DASHBOARD, MEMBER } from "../support/accounts"
import {
  TEST_INGEST_TOKEN,
  freshTradeNumbers,
  session1Today,
} from "../support/ingest"
import {
  AJAIB_TAB,
  LISTED_CODES,
  PING,
  SESSION_1,
  STOCKBIT_KEY,
  STOCKBIT_TAB,
  STOCKBIT_TOKEN,
  TICKS,
  launchWithExtension,
  sent,
  setRelayClock,
  startFakeBrokers,
  type BrokerSocket,
} from "../support/relay-extension"
import { readSubscribe, stockbitTradeFrameToday } from "../support/stockbit"
import { expect, test } from "../support/test"

// The relay-extension tests that relay to the real dashboard, and so to
// today's trading-day object. The ones that need only a fake ingest server
// live in relay-extension.spec.ts.

const TRADE_SUBSCRIBE =
  '{"method":"SUBSCRIBE","stream":"TRADE","streamObject":"*"}'

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
