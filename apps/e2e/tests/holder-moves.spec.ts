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

// The trimmed above-1% fixtures. Their Sep and Oct replace whatever the
// stocks spec seeded there, so Oct against Sep is theirs alone.
const ABOVE_1_MONTHS = [
  "2026-02-27",
  "2026-04-30",
  "2026-08-31",
  "2026-09-30",
  "2026-10-30",
]

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
  page
    .getByRole("heading", { name: "Holder moves" })
    .locator("xpath=../following-sibling::p")

const moves = (page: Page) =>
  page.getByRole("table", { name: "Holder moves" }).locator("tbody tr")

const railDay = (page: Page, day: RegExp) =>
  page.getByRole("button", { name: day })

const searchBox = (page: Page) =>
  page.getByRole("searchbox", { name: "Search stock, holder or broker" })

const kindToggle = (page: Page, name: "Daily" | "Monthly") =>
  page.getByRole("group", { name: "Kind" }).getByRole("button", { name })

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

    test("parses the archived above-5% days and above-1% months", async ({
      page,
    }) => {
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
      for (const month of ABOVE_1_MONTHS)
        await seedReportFixture(
          "above-1",
          `above-1-${month}.xlsx`,
          month,
          FETCHED_AT
        )
      await parseNow(page, "investor-type")
      await parseNow(page, "above-5%")
      await parseNow(page, "above-1%")
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

    test("switches to a month's moves, keeping each kind's period, and opens a stock", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MOVES}?day=2026-11-19`)
      await expect(kindToggle(page, "Daily")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await clickUntil(kindToggle(page, "Monthly"), () =>
        expect(page).toHaveURL(/[?&]kind=monthly/, { timeout: 1000 })
      )
      // The newest parsed month, against the one before.
      await expect(headline(page)).toHaveText(
        "15 holders above 1% moved across 5 stocks in Oct 2026, against Sep 2026."
      )
      await expect(
        page.getByRole("table", { name: "Holder moves" }).locator("thead th")
      ).toHaveText([
        "Stock",
        "Holder",
        "Move",
        "Lots",
        "Stake",
        "Change",
        "Trend",
      ])
      // TLKM's Danantara, back on the list under a new name.
      await expect(
        moves(page).filter({ hasText: /^TLKM.*DANANTARA ASSET MANAGEMENTNew/ })
      ).toContainText("under 1% → 52.16%")

      await railDay(page, /^Sep 2026: 3 new or up, 5 down or off list$/).click()
      await expect(page).toHaveURL(/[?&]month=2026-09/)
      await expect(headline(page)).toHaveText(
        "8 holders above 1% moved across 5 stocks in Sep 2026, against Aug 2026."
      )

      // Each kind comes back on the period picked in it.
      await kindToggle(page, "Daily").click()
      await expect(headline(page)).toContainText("on 19 Nov 2026")
      await kindToggle(page, "Monthly").click()
      await expect(headline(page)).toContainText("in Sep 2026")

      // The row opens TLKM's Major holders in that month.
      await moves(page)
        .filter({ hasText: "THE BANK OF NEW YORK MELLON" })
        .getByRole("link", { name: /^TLKM / })
        .click()
      await expect(page).toHaveURL(
        /\/stocks\/TLKM\?holdersMonth=2026-09#major-holders$/
      )
      const majorHolders = page.getByRole("region", { name: "Major holders" })
      await expect(
        majorHolders
          .getByRole("group", { name: "Month" })
          .getByRole("button", { name: "Sep 2026", exact: true })
      ).toHaveAttribute("aria-pressed", "true")
      await expect(
        majorHolders
          .getByRole("table", { name: "Major holders" })
          .getByRole("row")
          // Not its depositary receipts' holder, off list since April.
          .filter({ hasText: /THE BANK OF NEW YORK MELLON(?! DR)/ })
      ).toContainText("Down")
    })
  })
})
