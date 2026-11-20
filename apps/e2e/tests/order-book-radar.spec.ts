// The order book radar's scanner of spec apinrdw/kumora#517: every code
// above the value floor, today or on the previous trading day, split into
// the Bid-heavy and Offer-heavy halves and ranked within each; a row
// unfolds its best 5 levels and opens Market Live. The Book events feed
// lists the scanner's codes' events and opens Market Live at one.
//
// Books go through the relay to the Test stage's trading-day object. Its
// previous trading day was never sealed, and the codes made here trade
// nothing, so the page's socket goes through Playwright, which writes each
// snapshot's scanner figures (last price, previous close, previous day's
// value) for this spec's codes, and can add book events to it. Search keeps
// each test to its own prefix.
import type { Page } from "@playwright/test"

import { DASHBOARD, MEMBER } from "../support/accounts"
import { seedSpecialBoard } from "../support/holdings"
import { marketNow } from "../support/clock"
import { freshCode, openIngest } from "../support/ingest"
import { stockbitOrderBookFrame } from "../support/stockbit"
import { expect, test } from "../support/test"

test.use({ storageState: MEMBER.storageState })

const PAGE = "/order-book-radar"

interface Figures {
  readonly last?: number
  readonly previousClose?: number
  readonly previousValue?: number
  readonly value?: number
}

// A book event as the wire carries it, `at` in epoch ms.
type WireEvent = Record<string, unknown> & { code: string; at: number }

// Every snapshot's scanner figures, with `figures` for their codes, and its
// book events with `events`, stamped from the snapshot's send time.
const withFigures = (
  page: Page,
  figures: Record<string, Figures>,
  events: (sentAt: number) => ReadonlyArray<WireEvent> = () => []
) =>
  page.routeWebSocket(/\/market-live\/live$/, (socket) => {
    const server = socket.connectToServer()
    server.onMessage((message) => {
      if (typeof message !== "string") return socket.send(message)
      const parsed = JSON.parse(message) as {
        _tag: string
        at: number
        scannerFigures?: Array<[string, ...Array<number | null>]>
        bookEvents?: Array<WireEvent>
      }
      if (parsed._tag === "Snapshot") {
        parsed.bookEvents = [
          ...(parsed.bookEvents ?? []),
          ...events(parsed.at),
        ].sort((a, b) => a.at - b.at)
        const rows = (parsed.scannerFigures ?? []).filter(
          ([code]) => !(code in figures)
        )
        for (const [code, each] of Object.entries(figures))
          rows.push([
            code,
            each.last ?? null,
            each.previousClose ?? null,
            each.previousValue ?? null,
            each.value ?? 0,
          ])
        parsed.scannerFigures = rows
      }
      socket.send(JSON.stringify(parsed))
    })
  })

// `code`'s book: one bid level and one offer level of `bid` and `offer`
// lots, at 1,000 and 1,005.
const book = (code: string, bid: number, offer: number) => [
  stockbitOrderBookFrame(code, "BID", [[1000, 2, bid]]),
  stockbitOrderBookFrame(code, "OFFER", [[1005, 2, offer]]),
]

const half = (page: Page, name: "Bid-heavy" | "Offer-heavy") =>
  page.getByRole("region", { name })

// A half's codes, in order.
const codesOf = (page: Page, name: "Bid-heavy" | "Offer-heavy") =>
  half(page, name)
    .locator("li[data-code]")
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-code")))

const search = (page: Page, prefix: string) =>
  page.getByRole("searchbox", { name: "Search" }).fill(prefix)

const pickFloor = async (page: Page, label: string) => {
  await page.getByRole("combobox", { name: "Value floor" }).click()
  await page.getByRole("option", { name: label }).click()
}

const pickRank = async (page: Page, label: string) => {
  await page.getByRole("combobox", { name: "Rank by" }).click()
  await page.getByRole("option", { name: label, exact: true }).click()
}

test("the scanner loads under Market Live and covers codes by the value floor", async ({
  page,
}) => {
  const rich = freshCode("RL")
  const thin = freshCode("RL")
  const relay = await openIngest()
  await relay.sendStockbit([...book(rich, 300, 100), ...book(thin, 100, 300)])
  // 09:00: neither traded today; yesterday one did Rp2 B, the other Rp500 M.
  await withFigures(page, {
    [rich]: { previousValue: 2e9 },
    [thin]: { previousValue: 500e6 },
  })
  await page.goto(DASHBOARD)
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Order book radar" })
    .first()
    .click()
  await expect(page).toHaveURL(/\/order-book-radar$/)
  await search(page, "RL")
  // The default floor is Rp1 B.
  await expect.poll(() => codesOf(page, "Bid-heavy")).toContain(rich)
  await expect(
    half(page, "Bid-heavy").locator(`[data-code="${rich}"]`)
  ).toContainText("+50%")
  expect(await codesOf(page, "Offer-heavy")).not.toContain(thin)
  await expect(page.getByLabel("Coverage")).toContainText(
    /\d+ codes? above the floor/
  )
  await pickFloor(page, "Rp100 M")
  await expect.poll(() => codesOf(page, "Offer-heavy")).toContain(thin)
  // Kept in this browser.
  await page.reload()
  await expect(page.getByRole("combobox", { name: "Value floor" })).toHaveText(
    /Rp100 M/
  )
  await expect.poll(() => codesOf(page, "Offer-heavy")).toContain(thin)
  await expect(page.getByText("They don't predict price")).toBeVisible()
  relay.close()
})

test("the watchlist, search and price band filter the halves", async ({
  page,
}) => {
  const watched = freshCode("RF")
  const cheap = freshCode("RF")
  const dear = freshCode("RF")
  await page.addInitScript(
    ([key, seeded]) => window.localStorage.setItem(key, JSON.stringify(seeded)),
    ["kumora:market-live:watchlist", [watched]] as const
  )
  const relay = await openIngest()
  await relay.sendStockbit([
    ...book(watched, 300, 100),
    ...book(cheap, 200, 100),
    ...book(dear, 100, 300),
  ])
  await withFigures(page, {
    [watched]: { previousValue: 2e9, last: 1_000 },
    [cheap]: { previousValue: 2e9, last: 150 },
    [dear]: { previousValue: 2e9, last: 9_000 },
  })
  await page.goto(`${DASHBOARD}${PAGE}`)
  await search(page, "RF")
  await expect
    .poll(() => codesOf(page, "Bid-heavy"))
    .toEqual(expect.arrayContaining([watched, cheap]))
  await page.getByRole("button", { name: "Watchlist", exact: true }).click()
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([watched])
  await expect(
    half(page, "Bid-heavy").getByLabel("On the watchlist")
  ).toBeVisible()
  await page
    .getByRole("button", { name: "All above floor", exact: true })
    .click()
  await page.getByLabel("Lowest price").fill("500")
  await page.getByLabel("Highest price").fill("5000")
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([watched])
  expect(await codesOf(page, "Offer-heavy")).not.toContain(dear)
  await page.getByLabel("Lowest price").fill("100")
  await page.getByLabel("Highest price").fill("200")
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([cheap])
  relay.close()
})

test("Rank by orders each half in both directions, never mixing them", async ({
  page,
}) => {
  // Imbalance +50%, +80% and +20%; lots per order on the bid 150, 450 and
  // 75, each book's levels holding two orders.
  const a = freshCode("RR")
  const b = freshCode("RR")
  const c = freshCode("RR")
  const offer = freshCode("RR")
  const relay = await openIngest()
  await relay.sendStockbit([
    ...book(a, 300, 100),
    ...book(b, 900, 100),
    ...book(c, 150, 100),
    ...book(offer, 100, 300),
  ])
  await withFigures(page, {
    [a]: { previousValue: 2e9 },
    [b]: { previousValue: 2e9 },
    [c]: { previousValue: 2e9 },
    [offer]: { previousValue: 2e9 },
  })
  await page.goto(`${DASHBOARD}${PAGE}`)
  await search(page, "RR")
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([b, a, c])
  await expect.poll(() => codesOf(page, "Offer-heavy")).toEqual([offer])
  // Imbalance's figure: the heavy side's lots per order against the other's.
  await expect(
    half(page, "Bid-heavy")
      .locator(`[data-code="${b}"]`)
      .getByLabel("Ranked by")
  ).toHaveText("450 vs 50")
  await page.getByRole("button", { name: "High → low" }).click()
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([c, a, b])
  await page.getByRole("combobox", { name: "Rank by" }).click()
  for (const removed of [
    "Near depth bid",
    "Near depth offer",
    "Empty ticks",
    "Spread %",
  ])
    await expect(page.getByRole("option", { name: removed })).toHaveCount(0)
  await page
    .getByRole("option", { name: "Lots per order", exact: true })
    .click()
  // A new reading ranks High → low again.
  await expect(page.getByRole("button", { name: "High → low" })).toBeVisible()
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([b, a, c])
  await expect(
    half(page, "Bid-heavy")
      .locator(`[data-code="${b}"]`)
      .getByLabel("Ranked by")
  ).toHaveText("450 lots/ord")
  await page.getByRole("button", { name: "High → low" }).click()
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([c, a, b])
  await expect.poll(() => codesOf(page, "Offer-heavy")).toEqual([offer])
  relay.close()
})

test("Heavy side tags lopsided rows, filters the halves and ranks them", async ({
  page,
}) => {
  // Bid-heavy +80%: 450 lots per order against 50, big orders; 900 lots
  // in 60 orders against 50, small orders; and +20%, untagged.
  const big = freshCode("RH")
  const small = freshCode("RH")
  const untagged = freshCode("RH")
  const relay = await openIngest()
  await relay.sendStockbit([
    ...book(big, 900, 100),
    stockbitOrderBookFrame(small, "BID", [[1000, 60, 900]]),
    stockbitOrderBookFrame(small, "OFFER", [[1005, 2, 100]]),
    ...book(untagged, 150, 100),
  ])
  await withFigures(page, {
    [big]: { previousValue: 2e9 },
    [small]: { previousValue: 2e9 },
    [untagged]: { previousValue: 2e9 },
  })
  await page.goto(`${DASHBOARD}${PAGE}`)
  await search(page, "RH")
  const row = (code: string) =>
    half(page, "Bid-heavy").locator(`[data-code="${code}"]`)
  await expect(row(big).getByLabel("Heavy side")).toHaveText("big orders")
  await expect(row(small).getByLabel("Heavy side")).toHaveText("small orders")
  await expect(row(untagged).getByLabel("Heavy side")).toHaveCount(0)
  await pickRank(page, "Heavy side")
  await expect
    .poll(() => codesOf(page, "Bid-heavy"))
    .toEqual([big, small, untagged])
  await expect(row(big).getByLabel("Ranked by")).toHaveText("9.0×")
  const pickHeavySide = async (label: string) => {
    await page.getByRole("combobox", { name: "Heavy side" }).click()
    await page.getByRole("option", { name: label, exact: true }).click()
  }
  await pickHeavySide("Big orders")
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([big])
  await pickHeavySide("Small orders")
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([small])
  // Kept in this browser.
  await page.reload()
  await search(page, "RH")
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([small])
  await pickHeavySide("Any")
  await expect
    .poll(() => codesOf(page, "Bid-heavy"))
    .toEqual([big, small, untagged])
  relay.close()
})

test("the order holds while the pointer is on the list and re-sorts after", async ({
  page,
}) => {
  const first = freshCode("RH")
  const second = freshCode("RH")
  const relay = await openIngest()
  await relay.sendStockbit([
    ...book(first, 900, 100),
    ...book(second, 300, 100),
  ])
  await withFigures(page, {
    [first]: { previousValue: 2e9 },
    [second]: { previousValue: 2e9 },
  })
  await page.goto(`${DASHBOARD}${PAGE}`)
  await search(page, "RH")
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([first, second])
  await half(page, "Bid-heavy").locator(`[data-code="${second}"]`).hover()
  await expect(
    page.getByRole("status").filter({ hasText: "order held" })
  ).toBeVisible()
  // The second code turns the more lopsided: its reading shows, its place
  // holds past a re-sort.
  await relay.sendStockbit(book(second, 1900, 100))
  await expect(
    half(page, "Bid-heavy").locator(`[data-code="${second}"]`)
  ).toContainText("+90%")
  await page.waitForTimeout(6_000)
  expect(await codesOf(page, "Bid-heavy")).toEqual([first, second])
  await page.mouse.move(0, 0)
  await expect
    .poll(() => codesOf(page, "Bid-heavy"), { timeout: 8_000 })
    .toEqual([second, first])
  relay.close()
})

test("a row unfolds its best 5 levels and opens Market Live", async ({
  page,
}) => {
  const code = freshCode("RU")
  const relay = await openIngest()
  await relay.sendStockbit([
    stockbitOrderBookFrame(code, "BID", [
      [1000, 3, 300],
      [995, 1, 50],
    ]),
    stockbitOrderBookFrame(code, "OFFER", [[1005, 2, 100]]),
  ])
  await withFigures(page, { [code]: { previousValue: 2e9 } })
  await page.goto(`${DASHBOARD}${PAGE}`)
  await search(page, "RU")
  const row = half(page, "Bid-heavy").locator(`[data-code="${code}"]`)
  await row.getByRole("button").first().click()
  const bids = row.getByRole("list", { name: `${code} best bids` })
  await expect(bids.getByRole("listitem")).toHaveCount(2)
  await expect(bids.getByRole("listitem").first()).toContainText("1,000")
  await expect(
    row.getByRole("list", { name: `${code} best offers` })
  ).toContainText("1,005")
  await row.getByRole("button", { name: `Open ${code} in Market Live` }).click()
  await expect(page).toHaveURL(new RegExp(`/market-live\\?code=${code}$`))
  relay.close()
})

// An eaten offer at 1,000 on `code`, `ago` ms before `sentAt`.
const eaten = (code: string, sentAt: number, ago: number): WireEvent => ({
  kind: "eaten",
  code,
  at: sentAt - ago,
  side: "offer",
  price: 1000,
  lots: 500,
  orders: 3,
  share: 0.9,
})

test("Rank by Last event and Events in 5 minutes order each half", async ({
  page,
}) => {
  // One event a minute ago; three, the newest 5 s ago; none.
  const once = freshCode("RV")
  const busy = freshCode("RV")
  const none = freshCode("RV")
  const relay = await openIngest()
  await relay.sendStockbit([
    ...book(once, 300, 100),
    ...book(busy, 900, 100),
    ...book(none, 600, 100),
  ])
  await withFigures(
    page,
    {
      [once]: { previousValue: 2e9 },
      [busy]: { previousValue: 2e9 },
      [none]: { previousValue: 2e9 },
    },
    (sentAt) => [
      eaten(once, sentAt, 60_000),
      eaten(busy, sentAt, 100_000),
      eaten(busy, sentAt, 30_000),
      eaten(busy, sentAt, 5_000),
    ]
  )
  await page.goto(`${DASHBOARD}${PAGE}`)
  await search(page, "RV")
  await expect
    .poll(() => codesOf(page, "Bid-heavy"))
    .toEqual([busy, none, once])
  const row = (code: string) =>
    half(page, "Bid-heavy").locator(`[data-code="${code}"]`)
  await expect(row(busy).getByLabel("Last event").locator("abbr")).toHaveText(
    "EA"
  )
  await expect(
    row(busy).getByLabel("Last event").locator("abbr")
  ).toHaveAttribute("title", "Eaten: 1,000 gone, trades explain 90%")
  await expect(row(none).getByLabel("Last event")).toHaveText("")
  await pickRank(page, "Last event")
  await expect
    .poll(() => codesOf(page, "Bid-heavy"))
    .toEqual([busy, once, none])
  await expect(row(once).getByLabel("Ranked by")).toHaveText(/^1m ago$/)
  await expect(row(none).getByLabel("Ranked by")).toHaveText("—")
  await page.getByRole("button", { name: "High → low" }).click()
  await expect
    .poll(() => codesOf(page, "Bid-heavy"))
    .toEqual([once, busy, none])
  await pickRank(page, "Events in 5 minutes")
  await expect
    .poll(() => codesOf(page, "Bid-heavy"))
    .toEqual([busy, once, none])
  await expect(row(busy).getByLabel("Ranked by")).toHaveText("3 in 5m")
  await page.getByRole("button", { name: "High → low" }).click()
  await expect
    .poll(() => codesOf(page, "Bid-heavy"))
    .toEqual([none, once, busy])
  relay.close()
})

// Ten 1,000-lot bids from 1,000 down; at 990, a wall of 6,000 lots in 2
// orders when `wall`. Rp500 M is about 5,000 lots there.
const bidLevels = (wall: boolean) =>
  Array.from({ length: 10 }, (_, k) => {
    const price = 1000 - 5 * k
    return wall && price === 990
      ? ([price, 2, 6000] as const)
      : ([price, 10, 1000] as const)
  })

test("the feed lists the scanner's codes' book events live and opens Market Live at one", async ({
  page,
}) => {
  const code = freshCode("RE")
  await withFigures(page, { [code]: { previousValue: 2e9 } })
  await page.goto(`${DASHBOARD}${PAGE}`)
  await search(page, "RE")
  const relay = await openIngest()
  const now = marketNow()
  // Bid frames stamped 40 s and 20 s ago, then one 5 s ago with the wall,
  // each in its own delta: the last one's window reads the first two.
  for (const [ago, wall] of [
    [40_000, false],
    [20_000, false],
    [5_000, true],
  ] as const) {
    await relay.sendStockbit([
      stockbitOrderBookFrame(code, "BID", bidLevels(wall), now - ago),
      ...(ago === 40_000
        ? [stockbitOrderBookFrame(code, "OFFER", [[1005, 10, 900]], now - ago)]
        : []),
    ])
    await page.waitForTimeout(600)
  }
  const feed = page.getByRole("region", { name: "Book events" })
  const item = feed.getByRole("button", { name: new RegExp(code) })
  await expect(item).toContainText("Wall appeared")
  await expect(item).toContainText("6 K lots at 990 · 2 orders · 2 ticks away")
  await expect(
    half(page, "Bid-heavy")
      .locator(`[data-code="${code}"]`)
      .getByLabel("Last event")
  ).toHaveText("W+")
  // Only the scanner's codes.
  await search(page, "RZ")
  await expect(
    feed.getByRole("button", { name: new RegExp(code) })
  ).toHaveCount(0)
  await search(page, "RE")
  await item.click()
  await expect(page).toHaveURL(new RegExp(`/market-live\\?code=${code}&event=`))
  const picked = page
    .getByRole("region", { name: "Book readout" })
    .getByRole("region", { name: "Book events" })
    .getByRole("button", { name: /Wall appeared/ })
  await expect(picked).toHaveAttribute("aria-pressed", "true")
  await expect(picked).toBeInViewport()
  relay.close()
})

test("Special Monitoring Board and Rp1–10 codes never appear, and the note counts them", async ({
  page,
}) => {
  const board = freshCode("RX")
  const cheap = freshCode("RX")
  const shown = freshCode("RX")
  // Before the page loads: it reads the board list once a visit.
  seedSpecialBoard([board])
  const relay = await openIngest()
  await relay.sendStockbit([
    ...book(board, 300, 100),
    ...book(cheap, 300, 100),
    ...book(shown, 300, 100),
  ])
  await withFigures(page, {
    [board]: { previousValue: 2e9 },
    [cheap]: { previousValue: 2e9, previousClose: 8 },
    [shown]: { previousValue: 2e9 },
  })
  await page.goto(`${DASHBOARD}${PAGE}`)
  await search(page, "RX")
  await expect.poll(() => codesOf(page, "Bid-heavy")).toEqual([shown])
  await expect(page.getByLabel("Coverage")).toContainText(
    /\d+ Special Monitoring Board codes? and \d+ codes? at Rp1–10 are not ranked/
  )
  relay.close()
})

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test("the halves stack, the book events feed under them", async ({
    page,
  }) => {
    const bid = freshCode("RP")
    const offer = freshCode("RP")
    const relay = await openIngest()
    await relay.sendStockbit([...book(bid, 300, 100), ...book(offer, 100, 300)])
    await withFigures(page, {
      [bid]: { previousValue: 2e9 },
      [offer]: { previousValue: 2e9 },
    })
    await page.goto(`${DASHBOARD}${PAGE}`)
    await search(page, "RP")
    await expect.poll(() => codesOf(page, "Offer-heavy")).toEqual([offer])
    const top = await half(page, "Bid-heavy").boundingBox()
    const below = await half(page, "Offer-heavy").boundingBox()
    expect(below!.y).toBeGreaterThanOrEqual(top!.y + top!.height)
    expect(below!.x).toBeCloseTo(top!.x, 0)
    const feed = await page
      .getByRole("region", { name: "Book events" })
      .boundingBox()
    expect(feed!.y).toBeGreaterThanOrEqual(below!.y + below!.height)
    // No horizontal scroll.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
    relay.close()
  })
})
