import type { Page } from "@playwright/test"

import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"
import {
  seedClassificationMonths,
  seedInvestorTypeMonths,
  seedKseiMonths,
} from "../support/holdings"

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

// BBCA's rows in KSEI's May, Sep and Oct 2026 reports: Jun to Aug is a gap.
// October's date matches the report's, so BBCA's 19 B scripless shares are
// 15.41% of its listed shares; KSEI has no March. Only KSEI has APOL.
const KSEI_MONTHS = {
  "2026-05-29": {
    BBCA: {
      listedShares: 123_275_050_000,
      price: 5700,
      local: {
        IS: 2_233_048_535,
        CP: 602_033_335,
        PF: 314_872_400,
        IB: 436_320_900,
        ID: 10_600_358_384,
        MF: 1_162_747_459,
        SC: 117_039_473,
        FD: 66_741_160,
        OT: 12_495_900,
      },
      foreign: {
        IS: 600_834_357,
        CP: 1_315_044_503,
        PF: 5_137_965_177,
        IB: 2_649_194_950,
        ID: 323_497_180,
        MF: 19_474_983_937,
        SC: 530_018_307,
        FD: 300_789_505,
        OT: 6_575_705_658,
      },
    },
  },
  "2026-09-30": {
    BBCA: {
      listedShares: 123_275_050_000,
      price: 6075,
      local: {
        IS: 2_443_936_090,
        CP: 671_347_885,
        PF: 325_321_300,
        IB: 437_363_600,
        ID: 11_035_044_652,
        MF: 1_210_601_063,
        SC: 106_939_090,
        FD: 73_781_960,
        OT: 14_333_700,
      },
      foreign: {
        IS: 649_668_050,
        CP: 623_633_631,
        PF: 5_028_638_519,
        IB: 2_276_862_272,
        ID: 328_344_780,
        MF: 20_806_195_113,
        SC: 409_080_321,
        FD: 325_704_405,
        OT: 5_686_894_689,
      },
    },
  },
  "2026-10-30": {
    BBCA: {
      listedShares: 123_275_050_000,
      price: 4980,
      local: {
        IS: 2_310_613_490,
        CP: 752_250_260,
        PF: 302_459_300,
        IB: 517_672_400,
        ID: 12_030_567_470,
        MF: 1_072_720_030,
        SC: 119_977_978,
        FD: 72_753_960,
        OT: 15_254_200,
      },
      foreign: {
        IS: 666_444_425,
        CP: 575_351_467,
        PF: 4_718_402_998,
        IB: 2_382_605_437,
        ID: 324_800_480,
        MF: 20_393_323_810,
        SC: 457_281_188,
        FD: 320_342_605,
        OT: 5_420_869_622,
      },
    },
    APOL: { listedShares: 16e9, price: 0, local: {}, foreign: {} },
  },
}

// AADI's Nov 2025 rows equal what the investor-type parse run stores from
// its fixture (investor-type-2025-11-28.xlsx). BBCA's months use 100 B
// shares outstanding and 50 B scripless, so scrip is 50%; from April to
// October its ≥5% falls 1 point and its <5% rises 1.
const INVESTOR_TYPE_MONTHS = {
  "2025-11-28": {
    AADI: {
      sharesOutstanding: 7_786_891_760,
      combined: {
        ID: [1_412_471_655, 454_011_607],
        CP: [701_501_094, 4_397_166_772],
        MF: [331_782_018, 0],
        IB: [196_305_490, 0],
        IS: [81_345_483, 0],
        SC: [66_776_429, 0],
        PF: [73_223_227, 0],
        FD: [4_069_998, 0],
        OT: [68_237_987, 0],
      },
    },
  },
  "2026-04-30": {
    BBCA: {
      sharesOutstanding: 100e9,
      local: { ID: [12e9, 0], CP: [1e9, 10e9] },
      foreign: { MF: [20e9, 0], CP: [0, 7e9] },
    },
  },
  "2026-10-30": {
    BBCA: {
      sharesOutstanding: 100e9,
      local: { ID: [13e9, 0], CP: [1e9, 10e9] },
      foreign: { MF: [20e9, 0], CP: [0, 6e9] },
    },
    AADI: {
      sharesOutstanding: 7_786_891_760,
      local: { ID: [1.4e9, 0.45e9], CP: [0.7e9, 4.4e9] },
      foreign: { MF: [0.3e9, 0] },
    },
  },
} as const

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

const chart = (page: Page) =>
  page.getByRole("region", { name: "Holding composition (scripless)" })

const chartChoice = (page: Page, group: string, label: string) =>
  chart(page).getByRole("group", { name: group }).getByRole("button", {
    name: label,
    exact: true,
  })

const legendEntry = (page: Page, label: string) =>
  chartChoice(page, "Legend", label)

const column = (page: Page, label: string) =>
  chart(page)
    .getByRole("group", { name: "Holding chart" })
    .getByRole("button", { name: label })

const holderSize = (page: Page) =>
  page.getByRole("region", { name: "Holder size" })

const sizeChoice = (page: Page, group: string, label: string) =>
  holderSize(page).getByRole("group", { name: group }).getByRole("button", {
    name: label,
    exact: true,
  })

const sizeBar = (page: Page) =>
  holderSize(page).getByRole("group", { name: "Holder size bar" })

const sizeType = (page: Page, label: string) =>
  holderSize(page)
    .getByRole("table", { name: "Holder size by investor type" })
    .getByRole("row", { name: new RegExp(`^${label}`) })

const stockSearch = (page: Page) =>
  page
    .getByRole("banner")
    .getByRole("combobox", { name: "Open a stock", exact: true })

// Decision: serial, since every test reads the one HoldingsDb this block
// seeds. ksei-admin.spec.ts's Parse now test, which can run beside it,
// replaces the same HoldingsDb's KSEI months 2026-09-30 and 2026-10-30 with
// its fixtures: their BBCA rows equal KSEI_MONTHS', and no test here reads
// their other stocks' KSEI holdings, so either order reads the same.
// shareholding-admin.spec.ts's investor-type Parse now likewise replaces
// 2025-11-28 with its fixture, whose AADI rows equal
// INVESTOR_TYPE_MONTHS', and no test here opens its other stock, TRUE.
test.describe.serial("the stock page", () => {
  test.beforeAll(() => {
    seedClassificationMonths(MONTHS)
    seedKseiMonths(KSEI_MONTHS)
    seedInvestorTypeMonths(INVESTOR_TYPE_MONTHS)
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
      await expect(bar).toHaveText(/Scrip\s*Scripless\s*84\.59%\s*15\.41%/)
      await page.goto(`${DASHBOARD}/stocks/BBCA?month=2026-03`)
      await expect(bar).toContainText(
        "Unavailable: KSEI has no listed shares for Mar 2026."
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
      await expect(holderSize(page)).toContainText(
        "APOL isn't in IDX's investor-type report, so its holder size isn't shown."
      )
      // The picker offers it, though no report names its issuer.
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      const picker = page.getByRole("combobox", { name: "Stock", exact: true })
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
      await expect(holderSize(page)).toHaveCount(0)
      await expect(
        page.getByRole("combobox", { name: "Stock", exact: true })
      ).toBeVisible()
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

  test.describe("Holder size, for a member", () => {
    test.use({ storageState: MEMBER.storageState })

    test("splits shares outstanding into scrip, ≥5% and <5%, against the month before", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      // Between the two composition panels.
      await expect(page.getByRole("heading", { level: 2 })).toHaveText([
        "Shareholders composition",
        "Holder size",
        "Holding composition (scripless)",
      ])
      await expect(sizeChoice(page, "Month", "Oct 2026")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await expect(sizeChoice(page, "Month", "Nov 2025")).toHaveAttribute(
        "aria-disabled",
        "true"
      )
      await expect(sizeBar(page)).toContainText(/Scrip\s*50\.00%\s*0\.00 pts/)
      await expect(sizeBar(page)).toContainText(
        /≥5% holders\s*16\.00%\s*▼ 1\.00 pts/
      )
      await expect(sizeBar(page)).toContainText(
        /<5% holders\s*34\.00%\s*▲ 1\.00 pts/
      )
      // CP's ≥5% holders hold 16 of its 17 B shares.
      await expect(sizeType(page, "Corporate")).toHaveText(
        /Corporate\s*16\.00%\s*▼ 1\.00 pts\s*1\.00%\s*0\.00 pts\s*94\.12%/
      )
      await expect(sizeType(page, "Insurance")).toHaveText(
        /Insurance\s*0\.00%\s*0\.00 pts\s*0\.00%\s*0\.00 pts\s*–/
      )
      await expect(holderSize(page)).toContainText("Changes are from Apr 2026.")
      await expect(holderSize(page)).toContainText(
        "IDX counts a holder as ≥5% when one investor holds at least 5% of shares outstanding in scripless form."
      )
    })

    test("switches denominator and origin in the URL, and keeps them on reload", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      // The page has just loaded: retry until hydration lets it switch.
      await expect(async () => {
        await sizeChoice(page, "Share of", "Scripless").click()
        await expect(page).toHaveURL(/\/stocks\/BBCA\?sizeBase=scripless$/, {
          timeout: 1000,
        })
      }).toPass()
      await expect(sizeBar(page)).not.toContainText(/Scrip\s*\d/)
      await expect(sizeBar(page)).toContainText(/≥5% holders\s*32\.00%/)

      await sizeChoice(page, "Origin", "Local").click()
      await expect(page).toHaveURL(/sizeOrigin=local/)
      // Local is always of local scripless.
      await expect(
        sizeChoice(page, "Share of", "Shares outstanding")
      ).toHaveAttribute("aria-disabled", "true")
      await expect(sizeBar(page)).toContainText(
        /≥5% holders\s*41\.67%\s*▼ 1\.81 pts/
      )

      await page.reload()
      await expect(sizeChoice(page, "Origin", "Local")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await expect(sizeBar(page)).toContainText(/≥5% holders\s*41\.67%/)
    })

    test("opens the newest month the stock has, a gap disabled, and its first month", async ({
      page,
    }) => {
      // shareholding-admin.spec.ts's classification Parse now may give AADI
      // a Dec 2025 classification month, so its other panels aren't checked.
      await page.goto(`${DASHBOARD}/stocks/AADI`)
      await expect(sizeChoice(page, "Month", "Oct 2026")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await expect(sizeChoice(page, "Month", "Apr 2026")).toHaveAttribute(
        "aria-disabled",
        "true"
      )
      await expect(holderSize(page)).toContainText(
        "AADI isn't in Apr 2026's report, so no change is shown."
      )
      await expect(async () => {
        await sizeChoice(page, "Month", "Nov 2025").click()
        await expect(page).toHaveURL(/\/stocks\/AADI\?sizeMonth=2025-11$/, {
          timeout: 1000,
        })
      }).toPass()
      // Nov 2025 doesn't split local from foreign.
      const local = sizeChoice(page, "Origin", "Local")
      await expect(local).toHaveAttribute("aria-disabled", "true")
      await local.hover()
      await expect(
        page.getByText("Local: Not reported before Jan 2026")
      ).toBeVisible()
      await expect(holderSize(page)).toContainText("First month in the report.")
      await expect(sizeBar(page)).toContainText(/≥5% holders\s*62\.30%/)
      await expect(holderSize(page)).not.toContainText("pts")

      await page.reload()
      await expect(sizeChoice(page, "Month", "Nov 2025")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    })
  })

  test.describe("Holding composition, for a member", () => {
    test.use({ storageState: MEMBER.storageState })

    test("stacks local vs foreign from KSEI, a gap marked", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      await expect(chart(page)).toContainText("KSEI")
      await expect(chart(page).getByLabel("Local share")).toHaveText("32.78%")
      await expect(chart(page).getByLabel("Foreign share")).toHaveText("67.22%")
      await expect(chart(page)).toContainText("As of Oct 2026.")
      await expect(column(page, "Jul 2026")).toContainText("No data")
      // The page has just loaded: retry until hydration shows the tooltip.
      await expect(async () => {
        await page.mouse.move(0, 0)
        await column(page, "Oct 2026").hover()
        await expect(page.getByText("Share of scripless shares.")).toBeVisible({
          timeout: 1000,
        })
      }).toPass()
      await expect(
        page.getByRole("definition").filter({ hasText: "67.22%" })
      ).toBeVisible()
    })

    test("keeps a series' % of its origin when the legend hides the rest", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      await expect(async () => {
        await chartChoice(page, "Chart origin", "Foreign").click()
        await expect(page).toHaveURL(/\/stocks\/BBCA\?chart=foreign$/, {
          timeout: 1000,
        })
      }).toPass()
      await legendEntry(page, "Mutual fund").click()
      await expect(legendEntry(page, "Mutual fund")).toHaveAttribute(
        "aria-pressed",
        "false"
      )
      await legendEntry(page, "Individual").dblclick()
      for (const label of ["Mutual fund", "Corporate", "Others"])
        await expect(legendEntry(page, label)).toHaveAttribute(
          "aria-pressed",
          "false"
        )
      await expect(legendEntry(page, "Individual")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      // Individual alone is 0.92% of BBCA's foreign holdings, not 100%: the
      // axis zooms to 1%.
      // Tab reaches October from September, as a keyboard user would.
      await column(page, "Sep 2026").focus()
      await page.keyboard.press("Tab")
      await expect(column(page, "Oct 2026")).toBeFocused()
      await expect(
        page.getByText("Share of all foreign holdings.")
      ).toBeVisible()
      await expect(
        page.getByRole("definition").filter({ hasText: "0.92%" })
      ).toBeVisible()
      await expect(chart(page).getByText("1%", { exact: true })).toBeVisible()

      await legendEntry(page, "Individual").dblclick()
      await expect(legendEntry(page, "Mutual fund")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
    })

    test("switches to a table, kept in the URL on reload", async ({ page }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA?chart=foreign`)
      await expect(async () => {
        await chartChoice(page, "View", "Table").click()
        await expect(page).toHaveURL(
          /\/stocks\/BBCA\?chart=foreign&view=table$/,
          { timeout: 1000 }
        )
      }).toPass()
      await page.reload()
      const table = chart(page).getByRole("table", {
        name: "Holding composition by month",
      })
      await expect(table.getByRole("row", { name: /Oct 2026/ })).toContainText(
        "57.84%"
      )
      await expect(table.getByRole("row", { name: /Jul 2026/ })).toHaveText(
        /No data/
      )
      await expect(
        chartChoice(page, "Chart origin", "Foreign")
      ).toHaveAttribute("aria-pressed", "true")
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
