import { DASHBOARD, MEMBER } from "../support/accounts"
import { TEST_INGEST_TOKEN, session1Today } from "../support/ingest"
import {
  AJAIB_TAB,
  launchWithExtension,
  startFakeAjaib,
} from "../support/relay-extension"
import { expect, test } from "../support/test"

const TRADE_SUBSCRIBE =
  '{"method":"SUBSCRIBE","stream":"TRADE","streamObject":"*"}'
const PING = '{"method":"SUBSCRIBE","streamObject":"PING-WEB"}'

// The relay ticks every 10 s, so B, pings and reopens each take up to a tick
// or two.
const TICKS = { timeout: 25_000 }

test.use({ storageState: MEMBER.storageState })

test("the built extension relays a fake Ajaib tab's trades to the local trading-day object", async ({
  page,
}) => {
  test.setTimeout(120_000)
  const ajaib = await startFakeAjaib()
  const { context, optionsUrl } = await launchWithExtension(ajaib.port)
  try {
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

    // The Ajaib tab: its content script opens connection A from the tab.
    const tab = await context.newPage()
    await tab.goto(AJAIB_TAB)
    await expect.poll(() => ajaib.sockets.length).toBe(1)
    const a = ajaib.sockets[0]!
    await expect.poll(() => a.received).toEqual([TRADE_SUBSCRIBE])

    // Trades on A reach the trading-day object, and from it the tape.
    const frames = session1Today().slice(20, 30)
    for (const frame of frames) a.socket.send(frame)
    await page.goto(`${DASHBOARD}/market-live`)
    const tape = page.getByRole("region", { name: "Running trades" })
    await expect(tape.locator('tr[data-trade-number="22323"]')).toContainText(
      "BRMS"
    )

    // B opens one tick after A's first frame, fully subscribed.
    await expect.poll(() => ajaib.sockets.length, TICKS).toBe(2)
    const b = ajaib.sockets[1]!
    await expect.poll(() => b.received[0]).toBe(TRADE_SUBSCRIBE)

    // A quiet A sends PING-WEB on a tick.
    await expect.poll(() => a.received.includes(PING), TICKS).toBe(true)

    // A dropped A reopens at once.
    a.socket.terminate()
    await expect.poll(() => ajaib.sockets.length, TICKS).toBe(3)
    await expect.poll(() => ajaib.sockets[2]!.received[0]).toBe(TRADE_SUBSCRIBE)
  } finally {
    await context.close()
    await ajaib.close()
  }
})
