import type { Locator, Page } from "@playwright/test"

import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"
import { seedReportFixture } from "../support/shareholding"

const SHAREHOLDING = `${DASHBOARD}/admin/shareholding`
const HOLDER_MOVES = `${DASHBOARD}/holder-moves`

// Later than the shareholding admin spec's fixtures, so each day's newest
// version is this spec's: its 20 Nov 2026 is BIKE alone.
const FETCHED_AT = "2026-11-25T13:00:00.000Z"

// The trimmed above-5% fixtures, and the investor-type reports MAMIP's
// single-account counts resolve against.
const ABOVE_5_DAYS = [
  "2026-06-11",
  "2026-06-12",
  "2026-06-24",
  "2026-06-25",
  "2026-11-19",
  "2026-11-20",
]
const INVESTOR_TYPE_MONTHS = ["2026-05-29", "2026-10-30"]

const parseCard = (page: Page, kind: string) =>
  page.getByRole("region", { name: new RegExp(`Last ${kind} parse run`) })

// Presses the card's Parse now and waits for that run to end Complete.
async function parseNow(page: Page, kind: string) {
  await page.goto(SHAREHOLDING)
  await parseCard(page, kind).getByRole("button", { name: "Parse now" }).click()
  await expect(parseCard(page, kind)).toContainText(/Started admin-\d+\./)
  // The run ends on its own; the page shows it once reloaded.
  await expect(async () => {
    await page.reload()
    const card = parseCard(page, kind)
    await expect(card).toContainText("Complete", { timeout: 1000 })
    await expect(card.getByRole("button", { name: "Parse now" })).toBeEnabled({
      timeout: 1000,
    })
  }).toPass({ timeout: 60_000 })
}

const headline = (page: Page) =>
  page.getByRole("heading", { name: "Holder moves" }).locator("+ p")

const moves = (page: Page) =>
  page.getByRole("table", { name: "Holder moves" }).locator("tbody tr")

const railDay = (page: Page, day: RegExp) =>
  page.getByRole("button", { name: day })

const searchBox = (page: Page) =>
  page.getByRole("searchbox", { name: "Search stock, holder or broker" })

const moveFilter = (page: Page, name: RegExp) =>
  page.getByRole("group", { name: "Move" }).getByRole("button", { name })

// Clicks, retried until `then` holds, since a click before hydration does
// nothing.
async function clickUntil(target: Locator, then: () => Promise<void>) {
  await expect(async () => {
    await target.click()
    await then()
  }).toPass()
}

// Serial: an admin parses the fixtures, then a member reads the moves.
test.describe.serial("Holder moves", () => {
  test.describe("an admin", () => {
    test.use({ storageState: ADMIN.storageState })

    test("parses the archived above-5% days", async ({ page }) => {
      for (const month of INVESTOR_TYPE_MONTHS)
        await seedReportFixture(
          "investor-type",
          `investor-type-${month}.xlsx`,
          month,
          FETCHED_AT
        )
      for (const day of ABOVE_5_DAYS)
        await seedReportFixture(
          "above-5",
          `above-5-${day}.xlsx`,
          day,
          FETCHED_AT
        )
      await parseNow(page, "investor-type")
      await parseNow(page, "above-5%")
    })
  })

  test.describe("a member", () => {
    test.use({ storageState: MEMBER.storageState })

    test("reads a day's moves, filters, searches and opens a stock", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/`)
      await page.getByRole("link", { name: "Holder moves" }).first().click()
      await expect(page).toHaveURL(HOLDER_MOVES)
      await expect(page).toHaveTitle("Holder moves · KUMORA Terminal")
      // It opens on the newest parsed day: the rail's last, pressed.
      await expect(
        page.getByRole("button", { name: /^\d+ \w{3} 2026: / }).last()
      ).toHaveAttribute("aria-pressed", "true")

      // 20 Nov: ENRG's Maybank renamed with a trade, one holder Up; ASRI's
      // repeat blocks, gone that day, no move.
      // The newest day when no other spec seeded a later one.
      await page.goto(`${HOLDER_MOVES}?day=2026-11-20`)
      await expect(headline(page)).toHaveText(
        "4 holders above 5% moved across 3 stocks on 20 Nov 2026, against 19 Nov 2026."
      )
      await expect(moves(page)).toHaveCount(4)
      await expect(
        moves(page).filter({ hasText: "MAYBANK SEKURITAS INDONESIA" })
      ).toContainText(
        /Renamed from PT MAYBANK SEKURITAS INDONESIA - REGISTRAR\s*Up\s*ZP\s*\+200/
      )
      await expect(moves(page).filter({ hasText: "ASRI" })).toHaveCount(0)

      // 19 Nov, against 25 Jun.
      await clickUntil(
        railDay(page, /^19 Nov 2026: 9 new or up, 4 down or off list$/),
        () =>
          expect(page).toHaveURL(/\/holder-moves\?day=2026-11-19$/, {
            timeout: 1000,
          })
      )
      await expect(headline(page)).toHaveText(
        "13 holders above 5% moved across 5 stocks on 19 Nov 2026, against 25 Jun 2026."
      )
      await expect(page.getByText("Entered or left the list · 4")).toBeVisible()

      await moveFilter(page, /^New/).click()
      await expect(page).toHaveURL(/\/holder-moves\?day=2026-11-19&move=new$/)
      await expect(moves(page)).toHaveCount(3)
      await moveFilter(page, /^All/).click()

      // A broker code matches the moves through it.
      await searchBox(page).fill("zp")
      await expect(page).toHaveURL(/\/holder-moves\?day=2026-11-19&q=zp$/)
      await expect(moves(page)).toHaveCount(3)
      await searchBox(page).fill("no such holder")
      await expect(moves(page)).toHaveText([
        "No holder matches. Clear the search or pick All.",
      ])
      await searchBox(page).fill("trimegah")
      await expect(moves(page)).toHaveCount(1)

      // The row opens ENRG's Daily holders on that day.
      await moves(page)
        .getByRole("link", { name: /^ENRG / })
        .click()
      await expect(page).toHaveURL(
        /\/stocks\/ENRG\?holdersDay=2026-11-19#daily-holders$/
      )
      await expect(
        page
          .getByRole("region", { name: "Daily holders" })
          .getByRole("combobox", { name: "Trading day" })
      ).toHaveValue("2026-11-19")
    })
  })
})
