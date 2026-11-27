import type { Locator, Page } from "@playwright/test"

import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"
import { parseNow, seedHoldingsFixtures } from "../support/parsed-holdings"

const HOLDER_MAP = `${DASHBOARD}/holder-map`

const search = (page: Page) =>
  page.getByRole("combobox", { name: "Focus stock" })

const band = (page: Page, name: "5% and above" | "1% to 5%") =>
  page.getByRole("table", { name }).locator("tbody tr")

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
        /PT AGUNG PERKASA INVESTINDO\s*Local · Corporate\s*52\.83%/
      )
      await expect(band(page, "5% and above").nth(1)).toContainText(
        /PT PERINTIS TRINITI PROPERTI TBK\s*Local · Corporate\s*6\.95%/
      )
      await expect(band(page, "1% to 5%")).toHaveCount(2)
      await expect(band(page, "1% to 5%").nth(0)).toContainText(
        /VALTOS GLOBALINDO PT\s*Local · Type unknown\s*2\.72%/
      )
      await expect(band(page, "1% to 5%").nth(1)).toContainText(
        /VINCENT YO\s*Local · Individual\s*1\.42%/
      )
      await expect(
        page.getByRole("region", { name: "5% and above" })
      ).toContainText("2 holders · 59.78% · 20 Nov 2026")
      await expect(
        page.getByRole("region", { name: "1% to 5%" })
      ).toContainText("2 holders · 4.14% · Oct 2026")
    })

    test("opens from the stock page's Major holders and Daily holders", async ({
      page,
    }) => {
      for (const panel of ["Major holders", "Daily holders"]) {
        await page.goto(`${DASHBOARD}/stocks/TRUE`)
        await page
          .getByRole("region", { name: panel })
          .getByRole("link", { name: "Holder map of TRUE" })
          .click()
        await expect(page).toHaveURL(/\/holder-map\?stock=TRUE$/)
        await expect(
          page.getByRole("heading", { name: /^TRUE TRINITI DINAMIK/ })
        ).toBeVisible()
      }
    })

    test("opens from a Holder moves row, a Daily row as of its day", async ({
      page,
    }) => {
      const mapLink = (code: string) =>
        page
          .getByRole("table", { name: "Holder moves" })
          .getByRole("link", { name: `Holder map of ${code}` })
          .first()

      await page.goto(`${DASHBOARD}/holder-moves?day=2026-11-19`)
      await mapLink("ENRG").click()
      await expect(page).toHaveURL(
        /\/holder-map\?(?=.*stock=ENRG)(?=.*day=2026-11-19)/
      )
      await expect(
        page.getByText(/^5% band as of 19 Nov 2026 · /)
      ).toBeVisible()

      // A Monthly row's month isn't a trading day: the newest.
      await page.goto(`${DASHBOARD}/holder-moves?kind=monthly&month=2026-09`)
      await mapLink("TLKM").click()
      await expect(page).toHaveURL(/\/holder-map\?stock=TLKM$/)
      await expect(page.getByRole("heading", { name: /^TLKM / })).toBeVisible()
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
