import { DASHBOARD, MEMBER } from "../support/accounts"
import { signInUrl } from "../support/flows"
import { openIngest, session1Today } from "../support/ingest"
import { expect, test } from "../support/test"

const PAGE = "/market-live"

test.describe("signed in", () => {
  test.use({ storageState: MEMBER.storageState })

  test("Ajaib trades from the relay reach the tape, ordered by trade number", async ({
    page,
  }) => {
    const relay = await openIngest()
    const frames = session1Today()
    // Before the page opens: the snapshot carries these.
    await relay.sendAjaib(frames.slice(0, 10))
    await page.goto(`${DASHBOARD}${PAGE}`)
    const tape = page.getByRole("region", { name: "Running trades" })
    const row = (tradeNumber: string) =>
      tape.locator(`tr[data-trade-number="${tradeNumber}"]`)
    await expect(row("22265")).toContainText("BREN")
    await expect(row("22265")).toContainText("09:00:00")
    await expect(row("22265")).toContainText("2,130")
    // One dot for the one feed that saw it, explained by the header legend.
    await expect(row("22265").getByRole("img")).toHaveAccessibleName("Ajaib")
    await expect(
      tape.getByRole("list", { name: "Sources" }).getByRole("listitem")
    ).toHaveText(["Stockbit", "Ajaib", "Backfill"])

    // After: a delta. 22266 arrives late and sorts below 22268.
    await relay.sendAjaib(frames.slice(10, 20))
    await expect(row("22266")).toBeVisible()
    const numbers = await tape
      .locator("tbody tr")
      .evaluateAll((rows) =>
        rows.map((r) => r.getAttribute("data-trade-number"))
      )
    expect(numbers.indexOf("22266")).toBeGreaterThan(numbers.indexOf("22268"))
    relay.close()
  })

  test("a feed drop flips its pill, and both down dims the tape with STALE", async ({
    page,
  }) => {
    const relay = await openIngest()
    await relay.sendAjaib(session1Today().slice(0, 5))
    await relay.report("Stockbit", "alive")
    await page.goto(`${DASHBOARD}${PAGE}`)
    const status = page.getByRole("group", { name: "Market status" })
    const pill = (feed: string) =>
      status.getByRole("listitem").filter({ hasText: feed })
    const tape = page.getByRole("region", { name: "Running trades" })
    // The Test stage's clock offset puts the market in session 1.
    await expect(status.getByLabel("Market phase")).toHaveText("Session 1")
    await expect(pill("Stockbit")).toContainText("LIVE")
    await expect(pill("Ajaib")).toContainText("LIVE")
    // The morning before the first relay connected wasn't recorded.
    await expect(tape.locator("tr[data-relay-gap]").first()).toContainText(
      "Not recorded"
    )

    await relay.report("Stockbit", "closed")
    await expect(pill("Stockbit")).toContainText("UNAVAILABLE")
    await expect(pill("Ajaib")).toContainText("LIVE")
    await expect(tape).not.toHaveAttribute("data-stale")

    await relay.report("Ajaib", "closed")
    await expect(pill("Ajaib")).toContainText("UNAVAILABLE")
    await expect(tape).toHaveAttribute("data-stale", "true")
    await expect(tape.getByText("STALE", { exact: true })).toBeVisible()
    // The last trades stay on screen.
    await expect(tape.locator("tr[data-trade-number]").first()).toBeVisible()
    relay.close()
  })

  test("a dropped page socket shows Reconnecting… without blaming the feeds", async ({
    page,
  }) => {
    // The page's socket goes through Playwright: the test drops it, then
    // refuses reconnects until it lets one through.
    let accept = true
    let dropPage: (() => void) | undefined
    await page.routeWebSocket(/\/market-live\/live$/, (socket) => {
      if (!accept) return socket.close({ code: 1012, reason: "Restart" })
      socket.connectToServer()
      dropPage = () => {
        accept = false
        void socket.close({ code: 1012, reason: "Restart" })
      }
    })
    await page.goto(`${DASHBOARD}${PAGE}`)
    const status = page.getByRole("group", { name: "Market status" })
    await expect(status.getByRole("list", { name: "Feeds" })).toBeVisible()
    await expect.poll(() => dropPage !== undefined).toBe(true)
    dropPage!()
    await expect(status.getByRole("status")).toHaveText("Reconnecting…")
    await expect(status.getByRole("list", { name: "Feeds" })).toBeHidden()
    await expect(
      page.getByRole("region", { name: "Running trades" })
    ).toHaveAttribute("data-stale", "true")
    // The reconnect's fresh snapshot brings the pills back.
    accept = true
    await expect(status.getByRole("list", { name: "Feeds" })).toBeVisible({
      timeout: 15_000,
    })
  })

  test("the nav leads to Market Live", async ({ page }) => {
    await page.goto(`${DASHBOARD}/account`)
    await page.getByRole("link", { name: "Market Live" }).first().click()
    await expect(page).toHaveURL(`${DASHBOARD}${PAGE}`)
  })

  test("a signed-out reconnect closes with 4401 and lands on sign-in", async ({
    page,
    context,
  }) => {
    // The page's socket goes through Playwright, so the test can drop it.
    let dropPage: (() => void) | undefined
    await page.routeWebSocket(/\/market-live\/live$/, (socket) => {
      const server = socket.connectToServer()
      dropPage = () => socket.close({ code: 1012, reason: "Restart" })
      void server
    })
    await page.goto(`${DASHBOARD}${PAGE}`)
    await expect(
      page.getByRole("heading", { name: "Running trades" })
    ).toBeVisible()
    await expect.poll(() => dropPage !== undefined).toBe(true)
    await page.unrouteAll()
    await context.clearCookies()
    dropPage!()
    await expect(page).toHaveURL(signInUrl(PAGE), { timeout: 15_000 })
  })

  test("a 4426 close asks for a reload", async ({ page }) => {
    await page.routeWebSocket(/\/market-live\/live$/, (socket) =>
      socket.close({ code: 4426, reason: "New version, reload" })
    )
    await page.goto(`${DASHBOARD}${PAGE}`)
    await expect(page.getByRole("alert")).toContainText("Reload to continue")
  })
})

test("a signed-out visit goes to sign-in, keeping the page", async ({
  page,
}) => {
  await page.goto(`${DASHBOARD}${PAGE}`)
  await expect(page).toHaveURL(signInUrl(PAGE))
})

test("a wrong ingest token closes the ingest socket with 4403", async () => {
  const relay = await openIngest("not the token")
  expect(await relay.closed).toBe(4403)
})
