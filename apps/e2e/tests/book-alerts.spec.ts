// Book event alerts of spec apinrdw/kumora#517: this browser's alert rules,
// set in the order book radar's header, toast the live book events they
// match, at most once in 2 minutes per code and kind and 6 a minute, the
// rest folded into one count; the Alerts bell keeps today's. Heavy side
// alerts of spec apinrdw/kumora#605 toast a code's tag becoming big or
// small orders, and its order flow alerts toast an order flow event.
//
// The page's socket goes through Playwright, which sends it deltas of
// book events, order flow events and readings made here: the level
// ledger's and order flow's own rules are market-live-book-readout.spec.ts's
// and order-flow-events.spec.ts's. A snapshot of a code also lists the
// events sent for it, as the trading-day object's would.
import type { Page, WebSocketRoute } from "@playwright/test"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { marketNow, wibDate } from "../support/clock"
import { freshCode } from "../support/ingest"
import { expect, test } from "../support/test"

test.use({ storageState: MEMBER.storageState })

const PAGE = "/order-book-radar"

// A book event as the wire carries it.
interface Pulled {
  readonly kind: string
  readonly code: string
  readonly at: number
  readonly side: "bid" | "offer"
  readonly price: number
  readonly lots: number
  readonly orders: number
  readonly ticks?: number
  readonly approached?: boolean
  readonly share?: number
}

// A wall of 10 K lots at 9,000 (Rp9 B) pulled from `code`'s bid now.
const pulled = (code: string, at = marketNow()): Pulled => ({
  kind: "pulled",
  code,
  at,
  side: "bid",
  price: 9_000,
  lots: 10_000,
  orders: 3,
  ticks: 4,
  approached: false,
})

// An order flow event as the wire carries it.
interface Exhaustion {
  readonly kind: "exhaustion"
  readonly code: string
  readonly at: number
  readonly side: "buy" | "sell"
  readonly price: number
  readonly lots: number
  readonly peakLots: number
  readonly ticks: number
  readonly widestTicks: number
}

// `code`'s buying exhaustion at the day's high of 1,250, on the minute
// before now.
const exhaustion = (code: string): Exhaustion => ({
  kind: "exhaustion",
  code,
  at: Math.floor(marketNow() / 60_000) * 60_000 - 60_000,
  side: "buy",
  price: 1_250,
  lots: 900,
  peakLots: 2_400,
  ticks: 1,
  widestTicks: 5,
})

// A code's readings as the wire carries them: [code, as-of, imbalance, bid
// lots, bid lots per order, offer lots, offer lots per order].
type Readings = readonly [
  string,
  number,
  number,
  number,
  number,
  number,
  number,
]

// `code`'s book now, offer-heavy (−72%) with big orders: 118 lots per order
// against the bid's 22.
const offerHeavyBig = (code: string): Readings => [
  code,
  marketNow(),
  -0.72,
  1_400,
  22,
  8_600,
  118,
]

// The page's socket, through Playwright: `send` hands the open one a delta
// of book events, `sendOrderFlow` one of order flow events, `sendReadings`
// one of book readings.
const bookEventFeed = async (page: Page) => {
  let open: WebSocketRoute | undefined
  const sent: Array<Pulled> = []
  const sentFlow: Array<Exhaustion> = []
  await page.routeWebSocket(/\/market-live\/live$/, (socket) => {
    open = socket
    const server = socket.connectToServer()
    server.onMessage((message) => {
      if (typeof message !== "string") return socket.send(message)
      const parsed = JSON.parse(message) as {
        _tag: string
        selected?: string
        selectedBookEvents?: Array<unknown>
        selectedOrderFlowEvents?: Array<unknown>
      }
      if (parsed._tag === "Snapshot") {
        const own = sent.filter((event) => event.code === parsed.selected)
        if (own.length > 0)
          parsed.selectedBookEvents = [
            ...(parsed.selectedBookEvents ?? []),
            ...own,
          ]
        const ownFlow = sentFlow.filter(
          (event) => event.code === parsed.selected
        )
        if (ownFlow.length > 0)
          parsed.selectedOrderFlowEvents = [
            ...(parsed.selectedOrderFlowEvents ?? []),
            ...ownFlow,
          ]
      }
      socket.send(JSON.stringify(parsed))
    })
  })
  return {
    send: (events: ReadonlyArray<Pulled>) => {
      sent.push(...events)
      open?.send(
        JSON.stringify({
          _tag: "Delta",
          at: marketNow(),
          tape: [],
          candles: [],
          bookEvents: events,
        })
      )
    },
    sendOrderFlow: (events: ReadonlyArray<Exhaustion>) => {
      sentFlow.push(...events)
      open?.send(
        JSON.stringify({
          _tag: "Delta",
          at: marketNow(),
          tape: [],
          candles: [],
          orderFlowEvents: events,
        })
      )
    },
    sendReadings: (readings: ReadonlyArray<Readings>) =>
      open?.send(
        JSON.stringify({
          _tag: "Delta",
          at: marketNow(),
          tape: [],
          candles: [],
          bookReadings: readings,
        })
      ),
  }
}

// A rule saved from the header: Wall pulled on the named codes.
const savePulledRule = async (page: Page, codes: ReadonlyArray<string>) => {
  await page.getByRole("button", { name: "Alert rules" }).click()
  const sheet = page.getByRole("dialog", { name: "Alert rules" })
  const rule = sheet.getByRole("region", { name: "New rule" })
  await rule.getByRole("button", { name: "Wall pulled" }).click()
  await rule.getByRole("button", { name: "Named codes" }).click()
  await rule.getByLabel("Codes").fill(codes.join(", "))
  await rule.getByRole("button", { name: "Save rule" }).click()
  await expect(sheet.getByRole("list", { name: "Rules" })).toContainText(
    "Wall pulled ·"
  )
  await page.keyboard.press("Escape")
  await expect(sheet).toBeHidden()
}

// The radar, live: its snapshot has landed.
const openRadar = async (page: Page) => {
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect(page.locator("[data-feed]")).toHaveAttribute("data-feed", "live")
}

test("a rule's event toasts with its side and detail, and Open goes to it on Market Live", async ({
  page,
}) => {
  const code = freshCode("AL")
  const other = freshCode("AL")
  const feed = await bookEventFeed(page)
  await openRadar(page)
  await savePulledRule(page, [code])
  const event = pulled(code)
  // Another code, and another kind on this one, match no rule.
  const { ticks: _ticks, approached: _approached, ...common } = event
  feed.send([pulled(other), { ...common, kind: "eaten", share: 0.9 }])
  feed.send([event])
  const toast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: `${code} · Wall pulled on the bid` })
  await expect(toast).toContainText("10 K lots at 9,000 · 3 orders · 4 ticks")
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(1)
  await toast.getByRole("button", { name: "Open" }).click()
  await expect(page).toHaveURL(new RegExp(`/market-live\\?code=${code}&event=`))
  const events = page
    .getByRole("region", { name: "Book readout" })
    .getByRole("region", { name: "Events" })
  await expect(events.getByRole("button", { name: /Pulled/ })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
})

test("past 6 a minute the rest fold into one updating toast whose View opens the bell", async ({
  page,
}) => {
  const codes = Array.from({ length: 10 }, () => freshCode("AF"))
  const feed = await bookEventFeed(page)
  await openRadar(page)
  await savePulledRule(page, codes)
  feed.send(codes.slice(0, 9).map((code) => pulled(code)))
  const fold = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "more alerts this minute" })
  await expect(fold).toContainText("+3 more alerts this minute")
  feed.send([pulled(codes[9]!)])
  await expect(fold).toContainText("+4 more alerts this minute")
  await expect(fold).toHaveCount(1)
  // The fold never shows a code: 6 toasts named one.
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Wall pulled" })
  ).toHaveCount(6)
  await fold.getByRole("button", { name: "View" }).click()
  const bell = page.getByRole("dialog", { name: "Alerts" })
  await expect(bell.getByRole("listitem")).toHaveCount(10)
  await expect(bell.getByRole("listitem").first()).toContainText(
    `${codes[9]} · Wall pulled on the bid`
  )
})

test("the bell keeps today's alerts once per 2 minutes a code and kind, through a reload, and not another day's", async ({
  page,
}) => {
  const code = freshCode("AB")
  // Yesterday's alert, kept in this browser: the bell drops it.
  await page.addInitScript(
    ([day]) => {
      if (window.localStorage.getItem("kumora:book-alerts:history") !== null)
        return
      window.localStorage.setItem(
        "kumora:book-alerts:history",
        JSON.stringify({
          day,
          alerts: [
            {
              key: "OLD|pulled|bid|1|0",
              code: "OLDS",
              side: "bid",
              title: "OLDS · Wall pulled on the bid",
              detail: "yesterday",
              at: 0,
            },
          ],
        })
      )
    },
    [wibDate(marketNow() - 86_400_000)]
  )
  const feed = await bookEventFeed(page)
  await openRadar(page)
  const bellButton = page.getByRole("button", { name: /^Alerts/ })
  await expect(bellButton).toHaveText("Alerts")
  await savePulledRule(page, [code])
  const now = marketNow()
  feed.send([pulled(code, now - 1_000)])
  // A minute later on the event's clock: inside the cooldown.
  feed.send([{ ...pulled(code, now - 1_000 + 60_000), price: 9_100 }])
  await expect(bellButton).toHaveText("Alerts (1)")
  await page.reload()
  await expect(page.locator("[data-feed]")).toHaveAttribute("data-feed", "live")
  await bellButton.click()
  const bell = page.getByRole("dialog", { name: "Alerts" })
  await expect(bell.getByRole("listitem")).toHaveCount(1)
  await expect(bell).toContainText(`${code} · Wall pulled on the bid`)
  await expect(bell).not.toContainText("OLDS")
})

test("from a background tab an alert is a browser notification, not a toast", async ({
  page,
}) => {
  const code = freshCode("AN")
  // A hidden tab whose notifications are allowed, each one kept to read.
  await page.addInitScript(() => {
    const shown: Array<{ title: string; body?: string }> = []
    Object.assign(window, { shownNotifications: shown })
    class Recorded extends EventTarget {
      static permission = "granted"
      static requestPermission = () => Promise.resolve("granted")
      constructor(title: string, options?: NotificationOptions) {
        super()
        shown.push({ title, body: options?.body })
      }
      close() {}
    }
    Object.assign(window, { Notification: Recorded })
  })
  const feed = await bookEventFeed(page)
  await openRadar(page)
  await savePulledRule(page, [code])
  await page.evaluate(() =>
    Object.defineProperty(document, "visibilityState", { value: "hidden" })
  )
  feed.send([pulled(code)])
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { shownNotifications: Array<unknown> })
            .shownNotifications
      )
    )
    .toEqual([
      {
        title: `${code} · Wall pulled on the bid`,
        body: "10 K lots at 9,000 · 3 orders · 4 ticks",
      },
    ])
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0)
})

test("a code turning offer-heavy with big orders toasts once while the tag stays", async ({
  page,
}) => {
  const code = freshCode("AH")
  const feed = await bookEventFeed(page)
  await openRadar(page)
  await page.getByRole("button", { name: "Alert rules" }).click()
  const sheet = page.getByRole("dialog", { name: "Alert rules" })
  const rule = sheet.getByRole("region", { name: "New rule" })
  await rule.getByRole("button", { name: "Big orders" }).click()
  await expect(rule).toContainText(
    "Minimum value applies only to book event kinds."
  )
  await rule.getByRole("button", { name: "Named codes" }).click()
  await rule.getByLabel("Codes").fill(code)
  await rule.getByRole("button", { name: "Save rule" }).click()
  await expect(sheet.getByRole("list", { name: "Rules" })).toContainText(
    "Big orders ·"
  )
  await page.keyboard.press("Escape")
  await expect(sheet).toBeHidden()
  feed.sendReadings([offerHeavyBig(code)])
  const toast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: `${code} · Offer-heavy with big orders` })
  await expect(toast).toContainText("−72% · 118 vs 22 lots per order")
  feed.sendReadings([offerHeavyBig(code)])
  const bellButton = page.getByRole("button", { name: /^Alerts/ })
  await expect(bellButton).toHaveText("Alerts (1)")
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(1)
  // The readout lists no heavy side change: Open lands on the code alone.
  await toast.getByRole("button", { name: "Open" }).click()
  await expect(page).toHaveURL(new RegExp(`/market-live\\?code=${code}$`))
})

test("an order flow event toasts with its title and figures, and Open goes to it on Market Live", async ({
  page,
}) => {
  const code = freshCode("AO")
  const feed = await bookEventFeed(page)
  await openRadar(page)
  await page.getByRole("button", { name: "Alert rules" }).click()
  const sheet = page.getByRole("dialog", { name: "Alert rules" })
  const rule = sheet.getByRole("region", { name: "New rule" })
  await rule.getByRole("button", { name: "Exhaustion" }).click()
  await expect(rule).toContainText(
    "Minimum value applies only to book event kinds."
  )
  await rule.getByRole("button", { name: "Named codes" }).click()
  await rule.getByLabel("Codes").fill(code)
  await rule.getByRole("button", { name: "Save rule" }).click()
  await expect(sheet.getByRole("list", { name: "Rules" })).toContainText(
    "Exhaustion ·"
  )
  await page.keyboard.press("Escape")
  await expect(sheet).toBeHidden()
  feed.sendOrderFlow([exhaustion(code)])
  const toast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: `${code} · Buying exhaustion at the day's high` })
  await expect(toast).toContainText(
    "buy-aggressor lots 2,400 → 900 a minute · range 5 → 1 ticks"
  )
  await toast.getByRole("button", { name: "Open" }).click()
  await expect(page).toHaveURL(
    new RegExp(`/market-live\\?code=${code}&event=${code}`)
  )
  const picked = page
    .getByRole("region", { name: "Book readout" })
    .getByRole("region", { name: "Events" })
    .getByRole("button", { name: /Buying exhaustion/ })
  await expect(picked).toHaveAttribute("aria-pressed", "true")
})
