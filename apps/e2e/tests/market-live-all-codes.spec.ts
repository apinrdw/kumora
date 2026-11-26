// Market Live's All codes tab (apinrdw/kumora#703): the standout sweeps of
// every stock code, decided live by today's trading-day object, at or under
// the level the picker keeps for the browser, and refilled from the
// object's backlog on open and reconnect (apinrdw/kumora#704).
import type { Page } from "@playwright/test"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { marketNow, wibTime } from "../support/clock"
import {
  ajaibTradeToday,
  freshCode,
  freshTradeNumbers,
  openIngest,
} from "../support/ingest"
import { expect, test } from "../support/test"

const PAGE = "/market-live"

test.use({
  storageState: MEMBER.storageState,
  viewport: { width: 1920, height: 1080 },
})

// The sweeps a side holds before it stands out, as `WARM_UP` in
// apps/dashboard/src/server/market-live/sweep-alerts.ts.
const WARM_UP = 100

// `code`'s trades: a warm-up of WARM_UP buy sweeps of 1 to 100 lots, each
// between two-lot sells, so every trade is a sweep of its own; then, a second
// later and each after a one-lot sell, buy sweeps of 95, 97 and 99 lots,
// which reach its top 10%, 5% and 1%; and a trade the second after, which
// closes theirs. No sell stands out: the one-lot sells are under the two
// lots of every earlier sell. Returns the trades and the big sweeps' numbers
// by lots.
const standingOut = (code: string, base: number) => {
  const now = marketNow()
  const [warmAt, bigAt, laterAt] = [now - 2_000, now - 1_000, now].map(wibTime)
  const trade = (
    seq: number,
    time: string,
    lot: number,
    type: "BUY" | "SELL"
  ) =>
    ajaibTradeToday({
      seq: base + seq,
      time,
      ticker: code,
      price: 500,
      lot,
      type,
    })
  const warm = Array.from({ length: WARM_UP }, (_, index) => [
    trade(index * 2 + 1, warmAt!, index + 1, "BUY"),
    trade(index * 2 + 2, warmAt!, 2, "SELL"),
  ]).flat()
  const bigLots = [95, 97, 99] as const
  const big = bigLots.flatMap((lot, index) => [
    trade(1_000 + index * 2, bigAt!, 1, "SELL"),
    trade(1_001 + index * 2, bigAt!, lot, "BUY"),
  ])
  return {
    trades: [...warm, ...big, trade(1_100, laterAt!, 1, "SELL")],
    seqOf: { 95: 1_001, 97: 1_003, 99: 1_005 } as const,
  }
}

// The All codes list's rows of `code`, by their lots text.
const rowsOf = (page: Page, code: string) =>
  page
    .getByRole("region", { name: "All codes" })
    .locator(`button[data-code="${code}"]`)

test("the All codes tab fills live with a code's standout sweeps at the picked level, the 1% ones the sweeps that alert, and its picker survives a reload", async ({
  page,
}) => {
  const relay = await openIngest()
  const base = freshTradeNumbers()
  const code = freshCode("AC")
  // Another code is selected: the list is every code's.
  const other = freshCode("AO")
  await relay.sendAjaib([
    ajaibTradeToday({
      seq: base + 5_000,
      time: wibTime(marketNow()),
      ticker: other,
      price: 500,
      lot: 1,
    }),
  ])
  await page.goto(`${DASHBOARD}${PAGE}?code=${other}&panel=tape`)
  // The page is live once the other code's trade is on its tape.
  await expect(
    page
      .getByRole("region", { name: "Running trades" })
      .locator(`tr[data-trade-number="${base + 5_000}"]`)
  ).toBeVisible()
  const tabs = page.getByRole("tablist", { name: "Trades" })
  await expect(tabs.getByRole("tab")).toHaveText([
    `Buy/Sell sweeps · ${other}`,
    "All codes",
    "Running trades",
  ])
  await tabs.getByRole("tab", { name: "All codes" }).click()
  await expect(page).toHaveURL(/[?&]panel=allCodes(&|$)/)
  const list = page.getByRole("region", { name: "All codes" })
  await expect(list).toBeVisible()
  const picker = list.getByRole("radiogroup", { name: "Standout level" })
  // 1% until picked.
  await expect(picker.getByRole("radio", { checked: true })).toHaveText("1%")

  const { trades, seqOf } = standingOut(code, base)
  await relay.sendAjaib(trades)
  const rows = rowsOf(page, code)
  // At 1%, the one sweep that alerts.
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText("99 @ 500")
  await expect(rows.first()).toContainText("Buy")

  await picker.getByRole("radio", { name: "5%" }).click()
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText("99 @ 500")
  await expect(rows.nth(1)).toContainText("97 @ 500")

  await picker.getByRole("radio", { name: "10%" }).click()
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(2)).toContainText("95 @ 500")

  // Only the 1% sweep is marked on the tape, whatever the picker says.
  await tabs.getByRole("tab", { name: "Running trades" }).click()
  const tape = page.getByRole("region", { name: "Running trades" })
  const tapeRow = (seq: number) =>
    tape.locator(`tr[data-trade-number="${base + seq}"]`)
  await expect(tapeRow(seqOf[99])).toHaveAttribute("data-sweep-alert", "buy")
  for (const seq of [seqOf[97], seqOf[95]])
    await expect(tapeRow(seq)).not.toHaveAttribute("data-sweep-alert")

  // Clicking a row selects its code, and the All codes tab stays open.
  await tabs.getByRole("tab", { name: "All codes" }).click()
  await rows.first().click()
  await expect(page).toHaveURL(new RegExp(`[?&]code=${code}(&|$)`))
  await expect(tabs.getByRole("tab", { selected: true })).toHaveText(
    "All codes"
  )
  await expect(tabs.getByRole("tab").first()).toHaveText(
    `Buy/Sell sweeps · ${code}`
  )
  await expect(list).toBeVisible()

  // A reload keeps the picker's level.
  await page.reload()
  await expect(picker.getByRole("radio", { checked: true })).toHaveText("10%")
  relay.close()
})

test("a reload refills the All codes list from the object's backlog, and a reconnect neither duplicates nor drops its rows", async ({
  page,
}) => {
  // The page's socket goes through Playwright: the test counts its
  // snapshots, drops it, and can strip a snapshot's standout sweeps, as an
  // object restarted with an empty backlog sends.
  let snapshots = 0
  let emptyBacklog = false
  let dropPage: (() => void) | undefined
  await page.routeWebSocket(/\/market-live\/live$/, (socket) => {
    const server = socket.connectToServer()
    server.onMessage((message) => {
      if (typeof message !== "string") return socket.send(message)
      const parsed = JSON.parse(message) as {
        _tag: string
        standoutSweeps?: unknown
      }
      if (parsed._tag !== "Snapshot") return socket.send(message)
      snapshots += 1
      if (emptyBacklog) delete parsed.standoutSweeps
      socket.send(JSON.stringify(parsed))
    })
    dropPage = () => void socket.close({ code: 1012, reason: "Restart" })
  })

  const relay = await openIngest()
  const base = freshTradeNumbers()
  const code = freshCode("AB")
  const { trades } = standingOut(code, base)
  await relay.sendAjaib(trades)
  await page.goto(`${DASHBOARD}${PAGE}?code=${code}&panel=allCodes`)
  const rows = rowsOf(page, code)
  // The 1% sweep listed: the page is live before the picker is clicked.
  await expect(rows).toHaveCount(1)
  await page
    .getByRole("region", { name: "All codes" })
    .getByRole("radiogroup", { name: "Standout level" })
    .getByRole("radio", { name: "10%" })
    .click()
  const held = async () => {
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText("99 @ 500")
    await expect(rows.nth(1)).toContainText("97 @ 500")
    await expect(rows.nth(2)).toContainText("95 @ 500")
  }
  await held()

  // No delta brings them again: the reload's snapshot does.
  await page.reload()
  await held()

  // A reconnect's snapshot carries the rows the page holds: each once.
  const reconnected = async () => {
    const before = snapshots
    await expect.poll(() => dropPage !== undefined).toBe(true)
    dropPage!()
    await expect.poll(() => snapshots, { timeout: 15_000 }).toBe(before + 1)
  }
  await reconnected()
  await held()

  // A restarted object's snapshot carries none of them: the page keeps them.
  emptyBacklog = true
  await reconnected()
  await held()
  relay.close()
})
