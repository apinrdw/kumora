import type { Page } from "@playwright/test"

import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"
import { seedClassificationMonths, seedKseiMonths } from "../support/holdings"

const BBCA = "BANK CENTRAL ASIA Tbk"
const WBSA = "BSA LOGISTICS INDONESIA Tbk"
const BBRI = "BANK RAKYAT INDONESIA (PERSERO) Tbk"
// An issuer name with "bb" in it, under a code that doesn't start with BB.
const HOBI = "HOBBY NUSANTARA Tbk"

// Mar and May 2026 don't split local and foreign; Sep and Oct do. WBSA
// lists in May.
const MONTHS = {
  "2026-03-31": {
    BBCA: {
      issuer: BBCA,
      combined: {
        individual: 10e9,
        mutual_funds: 5e9,
        bank: 2e9,
        corporate: 1e9,
      },
    },
  },
  "2026-05-29": {
    BBCA: {
      issuer: BBCA,
      combined: {
        individual: 11e9,
        mutual_funds: 4e9,
        exchange_traded_funds: 5e8,
        bank: 2e9,
        corporate: 1e9,
      },
    },
    WBSA: { issuer: WBSA, combined: { individual: 12e8, corporate: 6e8 } },
  },
  "2026-09-30": {
    BBCA: {
      issuer: BBCA,
      local: { individual: 12e9, mutual_funds: 1e9 },
      foreign: { mutual_funds: 3e9, bank: 2e9, corporate: 1e9 },
    },
    WBSA: {
      issuer: WBSA,
      local: { individual: 11e8, corporate: 6e8 },
      foreign: { corporate: 1e8 },
    },
  },
  "2026-10-30": {
    BBCA: {
      issuer: BBCA,
      local: { individual: 12.5e9, mutual_funds: 1e9 },
      foreign: { mutual_funds: 2.5e9, bank: 2e9, corporate: 1e9 },
    },
    WBSA: {
      issuer: WBSA,
      local: { individual: 11e8, corporate: 6e8 },
      foreign: { corporate: 1e8 },
    },
    BBRI: { issuer: BBRI, local: { individual: 9e9 }, foreign: { bank: 3e9 } },
    HOBI: { issuer: HOBI, local: { individual: 5e8 }, foreign: {} },
  },
}

// Listed shares from KSEI: October's date matches the report's, so BBCA's
// 19 B scripless shares are 38% of its 50 B listed; KSEI has no September.
// Only KSEI has APOL.
const KSEI_MONTHS = {
  "2026-08-31": { BBCA: 50e9, APOL: 16e9 },
  "2026-10-30": { BBCA: 50e9, APOL: 16e9 },
}

const panel = (page: Page) =>
  page.getByRole("region", { name: "Shareholders composition" })

const holder = (page: Page, label: string) =>
  panel(page)
    .getByRole("list", { name: "Holders" })
    .getByRole("listitem")
    .filter({ hasText: label })

const monthTab = (page: Page, label: string) =>
  panel(page).getByRole("group", { name: "Month" }).getByRole("button", {
    name: label,
  })

const origin = (page: Page, label: string) =>
  panel(page).getByRole("group", { name: "Origin" }).getByRole("button", {
    name: label,
    exact: true,
  })

const stockSearch = (page: Page) =>
  page
    .getByRole("banner")
    .getByRole("combobox", { name: "Open a stock", exact: true })

// Serial: every test reads the one seeded HoldingsDb.
test.describe.serial("the stock page", () => {
  test.beforeAll(() => {
    seedClassificationMonths(MONTHS)
    seedKseiMonths(KSEI_MONTHS)
  })

  test.describe("for a member", () => {
    test.use({ storageState: MEMBER.storageState })

    test("opens a stock's newest month, compared with the month before", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      await expect(page).toHaveTitle("BBCA · KUMORA Terminal")
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        `BBCA ${BBCA}`
      )
      await expect(
        page.getByRole("navigation", { name: /breadcrumb/i })
      ).toContainText("Stocks")
      await expect(monthTab(page, "Oct 2026")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await expect(holder(page, "Individual")).toContainText("12.5 B")
      await expect(holder(page, "Individual")).toContainText("63.16% → 65.79%")
      await expect(holder(page, "Mutual fund")).toContainText("21.05% → 18.42%")
      // Unchanged: no previous figure shown.
      await expect(holder(page, "Financial institution")).toHaveText(
        /Financial institution\s*2 B\s*10\.53%/
      )
      await expect(panel(page)).toContainText("Retail")
      await expect(panel(page)).toContainText("65.79%")
      await expect(panel(page)).toContainText("Changes are from Sep 2026.")
    })

    test("switches month and origin in the URL, and keeps them on reload", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      // The page has just loaded: retry until hydration lets it switch.
      await expect(async () => {
        await origin(page, "Local").click()
        await expect(page).toHaveURL(/\/stocks\/BBCA\?panel=local$/, {
          timeout: 1000,
        })
      }).toPass()
      await expect(holder(page, "Individual")).toContainText("92.31% → 92.59%")
      await expect(panel(page)).toContainText("Total scripless shares (local)")

      await monthTab(page, "May 2026").click()
      await expect(page).toHaveURL(/month=2026-05/)
      // May doesn't split: Local is unavailable, and All shows.
      await expect(origin(page, "Local")).toHaveAttribute(
        "aria-disabled",
        "true"
      )
      await expect(origin(page, "All scripless")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await expect(holder(page, "Individual")).toContainText("55.56% → 59.46%")
      await expect(panel(page)).toContainText("Changes are from Mar 2026.")

      await page.getByRole("button", { name: "Show all 39 classes" }).click()
      await expect(holder(page, "Exchange traded funds")).toContainText("2.70%")
      await expect(holder(page, "Mutual funds")).toContainText("21.62%")

      await page.reload()
      await expect(page).toHaveURL(/month=2026-05/)
      await expect(monthTab(page, "May 2026")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      // Back on a split month, the URL's origin shows again.
      await expect(async () => {
        await monthTab(page, "Oct 2026").click()
        await expect(page).toHaveURL(/\/stocks\/BBCA\?panel=local$/, {
          timeout: 1000,
        })
      }).toPass()
      await expect(origin(page, "Local")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    })

    test("disables a month the stock isn't in", async ({ page }) => {
      await page.goto(`${DASHBOARD}/stocks/WBSA?month=2026-03`)
      // March has no WBSA row: its newest month opens.
      await expect(monthTab(page, "Oct 2026")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      const march = monthTab(page, "Mar 2026")
      await expect(march).toHaveAttribute("aria-disabled", "true")
      // The page has just loaded: retry until hydration shows the tooltip.
      await expect(async () => {
        await page.mouse.move(0, 0)
        await march.hover()
        await expect(
          page.getByText("WBSA isn't in Mar 2026's report.")
        ).toBeVisible({ timeout: 1000 })
      }).toPass()
      await expect(async () => {
        await monthTab(page, "May 2026").click()
        await expect(page).toHaveURL(/month=2026-05/, { timeout: 1000 })
      }).toPass()
      await expect(panel(page)).toContainText("First month in the report.")
      await expect(holder(page, "Individual")).not.toContainText("→")
    })

    test("switches stock with the picker", async ({ page }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      const picker = page.getByRole("combobox", { name: "Stock", exact: true })
      // The list loads once the page has hydrated.
      await expect(async () => {
        // A focus before hydration never opens the list: focus it again.
        await picker.blur()
        await picker.fill("WB")
        await expect(page.getByRole("option", { name: /WBSA/ })).toBeVisible({
          timeout: 1000,
        })
      }).toPass()
      await page.getByRole("option", { name: /WBSA/ }).click()
      await expect(page).toHaveURL(/\/stocks\/WBSA$/)
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        `WBSA ${WBSA}`
      )
    })

    test("shows scrip vs scripless from KSEI's listed shares", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      const bar = panel(page).getByRole("group", { name: "Scrip vs Scripless" })
      await expect(bar).toHaveText(/Scrip\s*Scripless\s*62\.00%\s*38\.00%/)
      await page.goto(`${DASHBOARD}/stocks/BBCA?month=2026-09`)
      await expect(bar).toContainText(
        "Unavailable: KSEI has no listed shares for Sep 2026."
      )
    })

    test("says a stock only KSEI has isn't in the report", async ({ page }) => {
      await page.goto(`${DASHBOARD}/stocks/APOL`)
      await expect(
        page.getByText(
          "APOL isn't in IDX's classification report, so its shareholders composition isn't shown."
        )
      ).toBeVisible()
      await expect(panel(page)).toHaveCount(0)
      // The picker offers it, though no report names its issuer.
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      const picker = page.getByRole("combobox", { name: "Stock" })
      await expect(async () => {
        await picker.blur()
        await picker.fill("AP")
        await expect(page.getByRole("option", { name: /APOL/ })).toBeVisible({
          timeout: 1000,
        })
      }).toPass()
    })

    test("says a stock neither source has has no data", async ({ page }) => {
      await page.goto(`${DASHBOARD}/stocks/ZZZZ`)
      await expect(
        page.getByText("No holdings data for ZZZZ. Pick another stock.")
      ).toBeVisible()
      await expect(page.getByRole("combobox", { name: "Stock" })).toBeVisible()
    })

    test("answers not found to a code that isn't a stock code", async ({
      page,
    }) => {
      const response = await page.goto(`${DASHBOARD}/stocks/bbca`)
      expect(response?.status()).toBe(404)
      await expect(
        page.getByRole("heading", { name: "Halaman tidak ditemukan" })
      ).toBeVisible()
    })
  })

  test.describe("for an admin", () => {
    test.use({ storageState: ADMIN.storageState })

    test("opens too", async ({ page }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      await expect(holder(page, "Individual")).toContainText("65.79%")
    })
  })

  test.describe("the Shell header's stock search", () => {
    test.use({ storageState: MEMBER.storageState })

    test("lists code matches before issuer names and opens the highlighted stock", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${DASHBOARD}/account`)
      const search = stockSearch(page)
      await expect(search).toBeVisible()
      // The list loads once the page has hydrated and the search has focus.
      await expect(async () => {
        await search.blur()
        await search.fill("bb")
        await expect(page.getByRole("option")).toHaveCount(3, {
          timeout: 1000,
        })
      }).toPass()
      await expect(page.getByRole("option")).toHaveText([
        /^BBCA/,
        /^BBRI/,
        /^HOBI/,
      ])
      await search.press("ArrowDown")
      await search.press("Enter")
      await expect(page).toHaveURL(/\/stocks\/BBRI$/)
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        `BBRI ${BBRI}`
      )
    })

    test("/ focuses it from Market Live", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${DASHBOARD}/market-live`)
      await expect(async () => {
        await page.locator("body").press("/")
        await expect(stockSearch(page)).toBeFocused({ timeout: 1000 })
      }).toPass()
      // Typed into the search, not the page's own palette.
      await expect(
        page.getByRole("dialog", { name: "Go to code" })
      ).toHaveCount(0)
    })

    test("collapses to an icon on a phone that opens a full-width search", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(`${DASHBOARD}/account`)
      await expect(stockSearch(page)).toBeHidden()
      const open = page.getByRole("button", { name: "Search stocks" })
      await expect(async () => {
        await open.click()
        await expect(stockSearch(page)).toBeFocused({ timeout: 1000 })
      }).toPass()
      const box = await stockSearch(page).boundingBox()
      // Full width, less the header's 16px gutters.
      expect(box?.width).toBeGreaterThanOrEqual(390 - 2 * 16 - 1)
      await stockSearch(page).fill("wb")
      await page.getByRole("option", { name: /WBSA/ }).click()
      await expect(page).toHaveURL(/\/stocks\/WBSA$/)
      await expect(stockSearch(page)).toBeHidden()
      await expect(open).toBeVisible()
    })

    test("/stocks opens Market Live's default, then the last stock viewed", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks`)
      await expect(page).toHaveURL(/\/stocks\/BBCA$/)
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        `BBCA ${BBCA}`
      )
      // The redirect ran in the browser, so the page has hydrated.
      await stockSearch(page).fill("wbsa")
      await expect(page.getByRole("option", { name: /WBSA/ })).toBeVisible()
      await stockSearch(page).press("Enter")
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        `WBSA ${WBSA}`
      )
      await page.goto(`${DASHBOARD}/stocks`)
      await expect(page).toHaveURL(/\/stocks\/WBSA$/)
    })
  })

  test.describe("the stock search for an admin", () => {
    test.use({ storageState: ADMIN.storageState })

    test("/ focuses it from an admin page", async ({ page }) => {
      await page.goto(`${DASHBOARD}/admin/users`)
      await expect(async () => {
        await page.locator("body").press("/")
        await expect(stockSearch(page)).toBeFocused({ timeout: 1000 })
      }).toPass()
      await page.keyboard.type("wbsa")
      await expect(page.getByRole("option", { name: /WBSA/ })).toBeVisible()
      await page.keyboard.press("Enter")
      await expect(page).toHaveURL(/\/stocks\/WBSA$/)
    })
  })

  test("sends a visitor with no session to sign-in", async ({ page }) => {
    await page.goto(`${DASHBOARD}/stocks/BBCA`)
    await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fstocks%2FBBCA/)
  })
})
