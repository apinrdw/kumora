import type { Locator, Page } from "@playwright/test"

import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"
import { parseNow, seedHoldingsFixtures } from "../support/parsed-holdings"

const HOLDER_MAP = `${DASHBOARD}/holder-map`

const search = (page: Page) =>
  page.getByRole("combobox", { name: "Focus stock" })

const band = (page: Page, name: "5% and above" | "1% to 5%") =>
  page.getByRole("table", { name }).locator("tbody tr")

// The map's chart, named by its focus and how many holders it draws; never
// its pixels.
const mapOf = (page: Page, code: string, holders?: number) =>
  page.getByRole("img", {
    name:
      holders === undefined
        ? new RegExp(`^Holder map of ${code}: `)
        : `Holder map of ${code}: ${holders} holders. The tables below list each.`,
  })

// Retried until `then` holds, since input before hydration does nothing.
async function until(act: () => Promise<void>, then: () => Promise<void>) {
  await expect(async () => {
    await act()
    await then()
  }).toPass()
}

async function pick(page: Page, typed: string, option: Locator) {
  await until(
    async () => {
      // The list opens on focus, so a focus before hydration needs another.
      await search(page).blur()
      await search(page).fill(typed)
    },
    () => expect(option).toBeVisible({ timeout: 1000 })
  )
  await option.click()
}

// Serial: an admin parses the fixtures, then a member reads the map.
test.describe.serial("Holder map", () => {
  test.describe("an admin", () => {
    test.use({ storageState: ADMIN.storageState })

    // One parse run per test, as the Holder moves spec does.
    test("parses the investor-type reports", async ({ page }) => {
      await seedHoldingsFixtures()
      await parseNow(page, "investor-type")
    })

    test("parses the archived above-5% days", async ({ page }) => {
      await parseNow(page, "above-5%")
    })

    test("parses the archived above-1% months", async ({ page }) => {
      await parseNow(page, "above-1%")
    })
  })

  test.describe("a member", () => {
    test.use({ storageState: MEMBER.storageState })

    test("opens the map from the nav on the stocks most held", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/`)
      await page.getByRole("link", { name: "Holder map" }).first().click()
      await expect(page).toHaveURL(HOLDER_MAP)
      await expect(page).toHaveTitle("Holder map · KUMORA Terminal")
      await expect(
        page.getByRole("heading", {
          name: "Stocks with the most ≥1% holders in Oct 2026",
        })
      ).toBeVisible()
      await expect(
        page
          .getByRole("list", { name: "Most held stocks" })
          .getByRole("link")
          .filter({ hasText: /^FLMC/ })
      ).toContainText("13 holders")
    })

    test("searches a stock and lists its two bands", async ({ page }) => {
      await page.goto(`${HOLDER_MAP}?day=2026-11-20`)
      await pick(page, "triniti", page.getByRole("option", { name: /^TRUE/ }))
      await expect(page).toHaveURL(
        /\/holder-map\?(?=.*stock=TRUE)(?=.*day=2026-11-20)/
      )
      await expect(
        page.getByRole("heading", { name: /^TRUE TRINITI DINAMIK/ })
      ).toBeVisible()
      await expect(
        page.getByText(
          "5% band as of 20 Nov 2026 · 1% band from Oct 2026's report"
        )
      ).toBeVisible()

      // 20 Nov's above-5% holders, then Oct's other ≥1% holders: Perintis,
      // in both reports, shows once, in the 5% band.
      await expect(band(page, "5% and above")).toHaveCount(2)
      await expect(band(page, "5% and above").nth(0)).toContainText(
        /PT AGUNG PERKASA INVESTINDO\s*Local · Corporate.*52\.83%/
      )
      await expect(band(page, "5% and above").nth(1)).toContainText(
        /PT PERINTIS TRINITI PROPERTI TBK\s*Local · Corporate.*6\.95%/
      )
      await expect(band(page, "1% to 5%")).toHaveCount(2)
      await expect(band(page, "1% to 5%").nth(0)).toContainText(
        /VALTOS GLOBALINDO PT\s*Local · Type unknown.*2\.72%/
      )
      await expect(band(page, "1% to 5%").nth(1)).toContainText(
        /VINCENT YO\s*Local · Individual.*1\.42%/
      )
      await expect(
        page.getByRole("region", { name: "5% and above" })
      ).toContainText("2 holders · 59.78% · 20 Nov 2026")
      await expect(
        page.getByRole("region", { name: "1% to 5%" })
      ).toContainText("2 holders · 4.14% · Oct 2026")
    })

    test("draws the focus and its holders as a map with a legend", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MAP}?stock=TRUE&day=2026-11-20`)
      // One node per holder the side panel lists.
      const map = mapOf(page, "TRUE", 4)
      await expect(map).toBeVisible()
      await expect(
        page.getByRole("list", { name: "Legend" }).getByRole("listitem")
      ).toHaveText([
        /^Stock/,
        /^Holder/,
        /^5% and above/,
        /^1% to 5%/,
        /^Local/,
      ])
      await expect(
        page.getByRole("button", { name: "Fit to view" })
      ).toBeEnabled()

      // The keyboard steps through the nodes, and the tooltip names each.
      await map.focus()
      await page.keyboard.press("ArrowRight")
      await expect(page.getByRole("status")).toContainText(
        /TRUE|AGUNG|PERINTIS|VALTOS|VINCENT/
      )
    })

    test("refocuses from the stocks most held and the search, and back and forward restore each focus", async ({
      page,
    }) => {
      await page.goto(HOLDER_MAP)
      await page
        .getByRole("list", { name: "Most held stocks" })
        .getByRole("link")
        .filter({ hasText: /^FLMC/ })
        .click()
      await expect(page).toHaveURL(/\/holder-map\?stock=FLMC$/)
      await expect(mapOf(page, "FLMC", 13)).toBeVisible()

      await pick(page, "TRUE", page.getByRole("option", { name: /^TRUE/ }))
      await expect(page).toHaveURL(/\/holder-map\?stock=TRUE$/)
      await expect(mapOf(page, "TRUE")).toBeVisible()

      await page.goBack()
      await expect(page).toHaveURL(/\/holder-map\?stock=FLMC$/)
      await expect(mapOf(page, "FLMC", 13)).toBeVisible()
      await page.goForward()
      await expect(page).toHaveURL(/\/holder-map\?stock=TRUE$/)
      await expect(mapOf(page, "TRUE")).toBeVisible()
    })

    test("shows each holder's move and hides the Off list on its toggle", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MAP}?stock=TRUE&day=2026-11-20`)
      // Perintis is down on 19 Nov; Agung holds as it did.
      await expect(band(page, "5% and above").nth(0)).toContainText("Unchanged")
      await expect(band(page, "5% and above").nth(1)).toContainText(
        /Down\s*−0\.77%/
      )

      // Panca left Sep's ≥1% list and Djoni Aug's.
      const offList = page.getByRole("list", { name: "Off list holders" })
      await expect(offList.getByRole("listitem")).toHaveCount(2)
      await expect(offList.getByRole("listitem").nth(0)).toContainText(
        /PT PANCA AGUNG GEMILANG.*Off list since Sep 2026/
      )
      await expect(offList.getByRole("listitem").nth(1)).toContainText(
        /DJONI.*Off list since Aug 2026/
      )
      const toggle = page.getByRole("button", { name: /^Show Off list/ })
      await expect(toggle).toHaveAttribute("aria-pressed", "true")
      await until(
        () => toggle.click(),
        () => expect(offList).toHaveCount(0, { timeout: 1000 })
      )
      await toggle.click()
      await expect(offList.getByRole("listitem")).toHaveCount(2)
    })

    test("marks a ≥1% holder at 5% or more missing from the day's above-5% list", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MAP}?stock=TRUE&day=2026-06-25`)
      await expect(band(page, "1% to 5%").nth(0)).toContainText(
        /PT PERINTIS TRINITI PROPERTI TBK.*≥5% at month-end, not on 25 Jun 2026's above-5% list/
      )
      await expect(band(page, "1% to 5%").nth(3)).not.toContainText(
        "≥5% at month-end"
      )
    })

    test("picks the as-of day, keeping the focus, and restores it on back", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MAP}?stock=TRUE`)
      const day = page.getByRole("combobox", { name: "Trading day" })
      await expect(day).toHaveValue("2026-11-20")
      await until(
        () => day.selectOption("2026-06-25").then(() => undefined),
        () => expect(page).toHaveURL(/day=2026-06-25/, { timeout: 1000 })
      )
      await expect(page).toHaveURL(
        /\/holder-map\?(?=.*stock=TRUE)(?=.*day=2026-06-25)/
      )
      await expect(
        page.getByText(
          "5% band as of 25 Jun 2026 · 1% band from Apr 2026's report"
        )
      ).toBeVisible()
      await expect(band(page, "5% and above")).toHaveCount(1)
      await expect(band(page, "5% and above").nth(0)).toContainText(
        "PT AGUNG PERKASA INVESTINDO"
      )

      await page.getByRole("button", { name: "Next trading day" }).click()
      await expect(page).toHaveURL(
        /\/holder-map\?(?=.*stock=TRUE)(?=.*day=2026-11-19)/
      )
      await expect(day).toHaveValue("2026-11-19")

      await page.goBack()
      await expect(page).toHaveURL(/day=2026-06-25/)
      await expect(day).toHaveValue("2026-06-25")
      await expect(
        page.getByRole("heading", { name: /^TRUE TRINITI DINAMIK/ })
      ).toBeVisible()
      await page.goBack()
      await expect(page).toHaveURL(`${HOLDER_MAP}?stock=TRUE`)
      await expect(day).toHaveValue("2026-11-20")
      await page.goForward()
      await expect(page).toHaveURL(/day=2026-06-25/)
      await expect(day).toHaveValue("2026-06-25")
    })

    test("refuses a day without an above-5% report", async ({ page }) => {
      await page.goto(`${HOLDER_MAP}?stock=TRUE&day=2026-06-13`)
      await expect(
        page.getByText("No above-5% report on 13 Jun 2026")
      ).toBeVisible()
      await expect(page.getByRole("table")).toHaveCount(0)
      const day = page.getByRole("combobox", { name: "Trading day" })
      await expect(day).toHaveValue("2026-06-13")
      await until(
        () => day.selectOption("2026-06-12").then(() => undefined),
        () => expect(page).toHaveURL(/day=2026-06-12/, { timeout: 1000 })
      )
      await expect(page).toHaveURL(/stock=TRUE/)
      await expect(
        page.getByText("No above-5% report on 13 Jun 2026")
      ).toHaveCount(0)
      await expect(
        page.getByRole("heading", { name: /^TRUE TRINITI DINAMIK/ })
      ).toBeVisible()
    })

    test("shows an empty state for a code no report lists", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MAP}?stock=ZZZZ`)
      await expect(page.getByText(/^No holders of ZZZZ on /)).toBeVisible()
      await expect(page.getByRole("table")).toHaveCount(0)
    })
  })
})
