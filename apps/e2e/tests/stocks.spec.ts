import type { Locator, Page } from "@playwright/test"

import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"
import {
  type SeededDay,
  seedBrokerTotals,
  tradingDaysBeforeToday,
} from "../support/broker-totals"
import {
  seedClassificationMonths,
  seedAbove1Months,
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
    // No ≥5% holders.
    HOBI: { sharesOutstanding: 1e9, local: { ID: [5e8, 0] }, foreign: {} },
  },
} as const

// BBCA's ≥1% holders in Aug and Sep 2026; Jul 2026 has only BBRI's, and
// UNVR's, a stock no other report has (as when its above-1% parse lands
// first). Each holder key is as src/server/holdings/above-1.ts builds it. Against Aug,
// Sep has Dwimuria unchanged on a few more shares, Anthoni Salim up,
// BlackRock down, Gamma off list, and Salim Group new on two rows.
// Decision: Feb and Apr 2026 are left unseeded, since
// shareholding-admin.spec.ts's Parse now parses them into the same
// HoldingsDb, with no BBCA or BBRI rows.
const ABOVE_1_MONTHS = {
  "2026-07-31": {
    UNVR: {
      issuer: "UNILEVER INDONESIA Tbk",
      rows: [
        {
          investor: "UNILEVER INDONESIA HOLDING BV",
          holderKey: "BV HOLDING INDONESIA UNILEVER",
          classification: "corporate",
          type: "CP",
          origin: "foreign",
          domicile: "NETHERLANDS",
          total: 32_500_000_000,
          hundredths: 8499,
        },
      ],
    },
    BBRI: {
      issuer: BBRI,
      rows: [
        {
          investor: "NEGARA REPUBLIK INDONESIA",
          holderKey: "INDONESIA NEGARA REPUBLIK",
          classification: "government",
          type: "OT",
          origin: "local",
          domicile: "INDONESIA",
          total: 80_610_976_875,
          hundredths: 5350,
        },
      ],
    },
  },
  "2026-08-31": {
    BBCA: {
      issuer: BBCA,
      rows: [
        {
          investor: "PT DWIMURIA INVESTAMA ANDALAN",
          holderKey: "ANDALAN DWIMURIA INVESTAMA",
          classification: "corporate",
          type: "CP",
          origin: "local",
          domicile: "INDONESIA",
          total: 67_729_950_000,
          hundredths: 5494,
        },
        {
          investor: "ANTHONI SALIM",
          holderKey: "ANTHONI SALIM",
          classification: "individual",
          type: "ID",
          origin: "local",
          domicile: "INDONESIA",
          total: 1_849_125_750,
          hundredths: 150,
        },
        {
          investor: "BLACKROCK INC",
          holderKey: "BLACKROCK INC",
          classification: "investment_manager",
          type: "SC",
          origin: "foreign",
          domicile: "UNITED STATES",
          total: 1_602_575_650,
          hundredths: 130,
        },
        {
          investor: "GAMMA FUND LTD",
          holderKey: "FUND GAMMA LTD",
          classification: "corporate",
          type: "CP",
          origin: "foreign",
          domicile: "SINGAPORE",
          total: 1_479_300_600,
          hundredths: 120,
        },
      ],
    },
  },
  "2026-09-30": {
    BBCA: {
      issuer: BBCA,
      rows: [
        {
          investor: "PT DWIMURIA INVESTAMA ANDALAN",
          holderKey: "ANDALAN DWIMURIA INVESTAMA",
          classification: "corporate",
          type: "CP",
          origin: "local",
          domicile: "INDONESIA",
          controller: "controller",
          total: 67_729_950_100,
          hundredths: 5494,
        },
        {
          investor: "ANTHONI SALIM",
          holderKey: "ANTHONI SALIM",
          classification: "individual",
          type: "ID",
          origin: "local",
          domicile: "INDONESIA",
          controller: "affiliate",
          total: 1_972_400_800,
          hundredths: 160,
        },
        {
          investor: "PT. SALIM GROUP",
          holderKey: "GROUP SALIM",
          classification: "corporate",
          type: "CP",
          origin: "local",
          domicile: "INDONESIA",
          total: 1_356_025_550,
          hundredths: 110,
        },
        {
          investor: "BLACKROCK INC",
          holderKey: "BLACKROCK INC",
          classification: "investment_manager",
          type: "SC",
          origin: "foreign",
          domicile: "UNITED STATES",
          total: 1_356_025_550,
          hundredths: 110,
        },
        {
          investor: "SALIM GROUP, PT",
          holderKey: "GROUP SALIM",
          scrip: 493_100_200,
          total: 493_100_200,
          hundredths: 40,
        },
      ],
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

// The Bars chart: one tab stop whose arrow keys step the months.
const bars = (page: Page) =>
  chart(page).getByRole("img", { name: /^Holding composition by month/ })

// The Bars tooltip, whose label is what a screen reader hears.
const barsTooltip = (page: Page) => chart(page).getByRole("status")

// Focuses the Bars chart and presses End, retried until the page has
// hydrated: the tooltip shows the newest month and the chart has focus.
// Decision: it checks focus too, since the tooltip can show over a chart
// that lost focus. The server renders the chart's SVG, so End can land
// before React hydrates it. React then hydrates it inside that key press,
// and the dev build's StrictMode runs the chart's effects twice, which
// replaces the focused SVG. The same key press still shows the tooltip.
const focusNewest = async (page: Page, month: string) => {
  await expect(async () => {
    await bars(page).blur()
    await bars(page).focus()
    await page.keyboard.press("End")
    await expect(barsTooltip(page)).toContainText(month, { timeout: 1000 })
    await expect(bars(page)).toBeFocused({ timeout: 1000 })
  }).toPass()
}

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

const sizeColumns = (page: Page) =>
  holderSize(page)
    .getByRole("list", { name: "Holder size by month" })
    .getByRole("button")

// Each Table view column, oldest first, by what it says.
const expectColumns = async (page: Page, names: ReadonlyArray<string>) => {
  await expect(sizeColumns(page)).toHaveCount(names.length)
  for (const [index, name] of names.entries())
    await expect(sizeColumns(page).nth(index)).toHaveAccessibleName(name)
}

const atLeast5Row = (page: Page, label: string) =>
  holderSize(page)
    .getByRole("table", { name: "≥5% holders by month" })
    .getByRole("row", { name: new RegExp(`^${label}`) })

const majorHolders = (page: Page) =>
  page.getByRole("region", { name: "Major holders" })

const holdersTab = (page: Page, label: string) =>
  majorHolders(page).getByRole("group", { name: "Month" }).getByRole("button", {
    name: label,
    exact: true,
  })

// A row of the holder table, by the holder's name.
const holderRow = (page: Page, name: string) =>
  majorHolders(page)
    .getByRole("table", { name: "Major holders" })
    .getByRole("row")
    .filter({ hasText: name })

// The Every month grid's rows, its header row first.
const everyMonthRows = (page: Page) =>
  majorHolders(page)
    .getByRole("table", { name: "Every month" })
    .getByRole("row")

const stockSearch = (page: Page) =>
  page
    .getByRole("banner")
    .getByRole("combobox", { name: "Open a stock", exact: true })

// Decision: serial, since every test reads the one HoldingsDb this block
// seeds. The admin specs' Parse now, beside it, replace KSEI's Sep and Oct
// 2026 and investor-type 2025-11-28 with fixtures whose BBCA and AADI rows
// equal this block's, no test here reads their other stocks' rows, and their
// Parse coverage checks take this seed's marks (apinrdw/kumora#405).
test.describe.serial("the stock page", () => {
  test.beforeAll(() => {
    seedClassificationMonths(MONTHS)
    seedKseiMonths(KSEI_MONTHS)
    seedInvestorTypeMonths(INVESTOR_TYPE_MONTHS)
    seedAbove1Months(ABOVE_1_MONTHS)
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

    test("switching stock carries the Broker inventory view and drops single brokers", async ({
      page,
    }) => {
      await page.goto(
        `${DASHBOARD}/stocks/BBCA?tab=brokers&range=1Y&measure=value&investor=domestic&brokers=MG%2Csell`
      )
      const picker = page.getByRole("combobox", { name: "Stock", exact: true })
      await expect(async () => {
        await picker.blur()
        await picker.fill("WB")
        await expect(page.getByRole("option", { name: /WBSA/ })).toBeVisible({
          timeout: 1000,
        })
      }).toPass()
      await page.getByRole("option", { name: /WBSA/ }).click()
      await expect(page).toHaveURL(
        /\/stocks\/WBSA\?tab=brokers&range=1Y&measure=value&investor=domestic&brokers=sell$/
      )
      await expect(lensPick(page, "Investor", "Domestic")).toHaveAttribute(
        "aria-pressed",
        "true"
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
      await expect(majorHolders(page)).toContainText(
        "APOL isn't in any IDX above-1% report, so its ≥1% holders aren't shown."
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

    test("shows Major holders for a stock only an above-1% report has", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/UNVR`)
      await expect(
        page.getByText(
          "UNVR isn't in IDX's classification report, so its shareholders composition isn't shown."
        )
      ).toBeVisible()
      await expect(
        holderRow(page, "UNILEVER INDONESIA HOLDING BV")
      ).toHaveCount(1)
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
      // Between the two composition panels, Major holders last.
      await expect(page.getByRole("heading", { level: 2 })).toHaveText([
        "Shareholders composition",
        "Holder size",
        "Holding composition (scripless)",
        "Major holders",
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

    test("switches to a Table of every month, kept in the URL on reload", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      await expect(async () => {
        await sizeChoice(page, "View", "Table").click()
        await expect(page).toHaveURL(/\/stocks\/BBCA\?sizeView=table$/, {
          timeout: 1000,
        })
      }).toPass()
      await page.reload()
      await expect(sizeChoice(page, "View", "Table")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      // ≥5% at the bottom, then <5%, then scrip.
      await expectColumns(page, [
        "Nov 2025: No data",
        "Apr 2026: ≥5% holders 17.00%, <5% holders 33.00%, Scrip 50.00%",
        "Oct 2026: ≥5% holders 16.00%, <5% holders 34.00%, Scrip 50.00%",
      ])
      await expect(atLeast5Row(page, "Corporate")).toHaveText(
        /Corporate\s*–\s*17\.00%\s*16\.00%/
      )
      await expect(
        holderSize(page)
          .getByRole("table", { name: "≥5% holders by month" })
          .getByRole("row")
      ).toHaveCount(2)
    })

    test("marks months without a local/foreign split n/a under Local", async ({
      page,
    }) => {
      await page.goto(
        `${DASHBOARD}/stocks/AADI?sizeView=table&sizeOrigin=local`
      )
      await expectColumns(page, [
        "Nov 2025: n/a, not split by origin",
        "Apr 2026: No data",
        "Oct 2026: ≥5% holders 69.78%, <5% holders 30.22%",
      ])
      await expect(atLeast5Row(page, "Individual")).toHaveText(
        /Individual\s*n\/a\s*–\s*6\.47%/
      )
      await expect(atLeast5Row(page, "Corporate")).toHaveText(
        /Corporate\s*n\/a\s*–\s*63\.31%/
      )

      await expect(async () => {
        await sizeChoice(page, "Origin", "All").click()
        await expect(page).toHaveURL(/\/stocks\/AADI\?sizeView=table$/, {
          timeout: 1000,
        })
      }).toPass()
      await expect(sizeColumns(page).first()).toHaveAccessibleName(
        /^Nov 2025: ≥5% holders 62\.30%/
      )
    })

    test("says a stock with no ≥5% holders has none", async ({ page }) => {
      await page.goto(`${DASHBOARD}/stocks/HOBI?sizeView=table`)
      await expect(holderSize(page)).toContainText(
        "HOBI has no ≥5% holders in any month."
      )
      await expect(
        holderSize(page).getByRole("table", { name: "≥5% holders by month" })
      ).toHaveCount(0)
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
      // The page opens at the newest month: hovering its column, the last,
      // shows its tooltip. Retried until hydration shows it.
      await expect(async () => {
        await page.mouse.move(0, 0)
        const box = await bars(page).boundingBox()
        if (box === null) throw new Error("The Bars chart has no box")
        await bars(page).hover({ position: { x: box.width - 22, y: 120 } })
        await expect(barsTooltip(page)).toContainText("Oct 2026", {
          timeout: 1000,
        })
      }).toPass()
      await expect(barsTooltip(page)).toContainText("67.22%")
      await expect(barsTooltip(page)).toContainText(
        "Share of scripless shares."
      )
      await page.mouse.move(0, 0)

      await focusNewest(page, "Oct 2026")
      await expect(barsTooltip(page)).toHaveAttribute(
        "aria-label",
        "Oct 2026\nForeign 67.22%, down from 68.89%\nLocal 32.78%, up from 31.11%\nShare of scripless shares."
      )
      await expect(barsTooltip(page)).toContainText("68.89% → 67.22%")
      // September follows August, a month KSEI has no data for.
      await page.keyboard.press("ArrowLeft")
      await expect(barsTooltip(page)).toContainText("Sep 2026")
      await expect(barsTooltip(page)).toContainText(
        "Aug 2026 has no data, so no change is shown."
      )
      await expect(barsTooltip(page)).not.toContainText("→")
      // Back past August to July, another such month.
      for (let step = 0; step < 2; step++)
        await page.keyboard.press("ArrowLeft")
      await expect(barsTooltip(page)).toContainText("Jul 2026")
      await expect(barsTooltip(page)).toContainText("No data")
      await expect(barsTooltip(page)).toHaveAttribute(
        "aria-label",
        "Jul 2026: No data, KSEI's report has no row for this month."
      )
      await expect(bars(page)).toContainText("No data")
    })

    test("Escape hides the Bars tooltip and the next arrow key brings it back", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      await focusNewest(page, "Oct 2026")
      await page.keyboard.press("Escape")
      await expect(barsTooltip(page)).toBeHidden()
      await expect(bars(page)).toBeFocused()
      // The arrow steps from the month Escape hid, not from the first.
      await page.keyboard.press("ArrowLeft")
      await expect(barsTooltip(page)).toContainText("Sep 2026")
    })

    test("Escape hides a hovered Bars tooltip while focus is elsewhere", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      // Retried until hydration shows it.
      await expect(async () => {
        await page.mouse.move(0, 0)
        const box = await bars(page).boundingBox()
        if (box === null) throw new Error("The Bars chart has no box")
        await bars(page).hover({ position: { x: box.width - 22, y: 120 } })
        await expect(barsTooltip(page)).toContainText("Oct 2026", {
          timeout: 1000,
        })
      }).toPass()
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(
        "BODY"
      )
      await page.keyboard.press("Escape")
      await expect(barsTooltip(page)).toBeHidden()
    })

    test("steps the arrow keys from the month the pointer hovered", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      await focusNewest(page, "Oct 2026")
      const box = await bars(page).boundingBox()
      if (box === null) throw new Error("The Bars chart has no box")
      // October's lower segment, not the month's own stop.
      await bars(page).hover({ position: { x: box.width - 22, y: 220 } })
      await expect(barsTooltip(page)).toContainText("Oct 2026")
      await page.keyboard.press("ArrowLeft")
      await expect(barsTooltip(page)).toContainText("Sep 2026")
    })

    test("steps the arrow keys from a hovered month that Escape hid", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      await focusNewest(page, "Oct 2026")
      const box = await bars(page).boundingBox()
      if (box === null) throw new Error("The Bars chart has no box")
      await bars(page).hover({ position: { x: box.width - 22, y: 220 } })
      await expect(barsTooltip(page)).toContainText("Oct 2026")
      await page.keyboard.press("Escape")
      await expect(barsTooltip(page)).toBeHidden()
      await page.keyboard.press("ArrowLeft")
      await expect(barsTooltip(page)).toContainText("Sep 2026")
    })

    test("styles the Bars tooltip as KTooltip", async ({ page }) => {
      const look = (element: Element) => {
        const style = getComputedStyle(element)
        return [
          "border-radius",
          "border-top-color",
          "border-top-width",
          "padding",
          "min-width",
          "max-width",
          "font-size",
          "line-height",
          "font-weight",
          "color",
          "background-color",
          "box-shadow",
        ].map((property) => `${property}: ${style.getPropertyValue(property)}`)
      }
      // May doesn't split, so the Local origin is a KTooltip trigger.
      await page.goto(`${DASHBOARD}/stocks/BBCA?month=2026-05`)
      const kTooltip = page.locator('[data-slot="tooltip-content"]')
      await expect(async () => {
        await page.mouse.move(0, 0)
        await origin(page, "Local").hover()
        await expect(kTooltip).toBeVisible({ timeout: 1000 })
      }).toPass()
      const kLook = await kTooltip.evaluate(look)
      await page.mouse.move(0, 0)
      await focusNewest(page, "Oct 2026")
      const body = barsTooltip(page).locator(".ts-chart-tooltip__body > *")
      expect(await body.evaluate(look)).toEqual(kLook)
    })

    test("keeps its scroll when the pointer hovers a column at the edge", async ({
      page,
    }) => {
      // On a narrow phone BBCA's six months overflow their scroller.
      await page.setViewportSize({ width: 320, height: 800 })
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      await focusNewest(page, "Oct 2026")
      await bars(page).blur()
      const scrollLeft = () =>
        bars(page).evaluate((element) => {
          let scroller = element.parentElement
          while (scroller && scroller.scrollWidth <= scroller.clientWidth)
            scroller = scroller.parentElement
          return scroller?.scrollLeft ?? 0
        })
      const opened = await scrollLeft()
      expect(opened).toBeGreaterThan(0)
      // The leftmost column in view, just inside the scroller's edge.
      await bars(page).hover({ position: { x: opened + 22, y: 120 } })
      await expect(barsTooltip(page)).toBeVisible()
      expect(await scrollLeft()).toBe(opened)
      // The keyboard still scrolls the oldest month into view.
      await bars(page).focus()
      await page.keyboard.press("Home")
      await expect(barsTooltip(page)).toContainText("May 2026")
      expect(await scrollLeft()).toBe(0)
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
      // One Tab from the origin picks reaches the chart, and the next leaves
      // it for the legend.
      await chartChoice(page, "Chart origin", "Foreign").focus()
      await page.keyboard.press("Tab")
      await expect(bars(page)).toBeFocused()
      await expect(barsTooltip(page)).toBeVisible()
      await page.keyboard.press("Tab")
      await expect(legendEntry(page, "Individual")).toBeFocused()
      await expect(barsTooltip(page)).toBeHidden()
      // Individual alone is 0.92% of BBCA's foreign holdings, not 100%: the
      // axis zooms to 1%.
      await focusNewest(page, "Oct 2026")
      await expect(barsTooltip(page)).toContainText(
        "Share of all foreign holdings."
      )
      await expect(barsTooltip(page)).toContainText("0.92%")
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
      // Foreign mutual funds, up from September.
      await expect(table.getByRole("row", { name: /Oct 2026/ })).toContainText(
        "▲57.84%, up from 57.58%"
      )
      await expect(table.getByRole("row", { name: /Jul 2026/ })).toHaveText(
        /No data/
      )
      await expect(
        chartChoice(page, "Chart origin", "Foreign")
      ).toHaveAttribute("aria-pressed", "true")
    })
  })

  test.describe("Major holders, for a member", () => {
    test.use({ storageState: MEMBER.storageState })

    test("lists the newest month's ≥1% holders against the month before", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      await expect(holdersTab(page, "Sep 2026")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await expect(holdersTab(page, "Jul 2026")).toHaveAttribute(
        "aria-disabled",
        "true"
      )
      await expect(majorHolders(page)).toContainText(
        "4 holders hold 59.14% of listed shares · vs Aug 2026: 1 new, 1 up, 1 down, 1 off list"
      )
      await expect(
        holderRow(page, "PT DWIMURIA INVESTAMA ANDALAN")
      ).toContainText(
        /Controller·Corporate·Local\s*Unchanged\s*54\.94%±0\.00 pp\s*67\.73 B\+100/
      )
      await expect(holderRow(page, "ANTHONI SALIM")).toContainText(
        /Affiliate of controller·Individual·Local\s*Up\s*1\.60%\+0\.10 pp/
      )
      await expect(holderRow(page, "BLACKROCK INC")).toContainText(
        /Investment manager·Foreign·UNITED STATES\s*Down\s*1\.10%−0\.20 pp/
      )
      // A holder on two rows shows once, summed, its scrip row included.
      const salim = holderRow(page, "PT. SALIM GROUP")
      await expect(salim).toContainText(/New\s*1\.50%\s*1\.85 B\s*27%/)
      await expect(async () => {
        await salim
          .getByRole("button", { name: "2 rows in the report" })
          .click()
        await expect(salim).toContainText("SALIM GROUP, PT · 493.1 M · 0.40%", {
          timeout: 1000,
        })
      }).toPass()
      // Off list, greyed at the bottom with its last %.
      const gamma = majorHolders(page)
        .getByRole("table", { name: "Major holders" })
        .getByRole("row")
        .last()
      await expect(gamma).toContainText(
        /GAMMA FUND LTD.*Off list\s*—was 1\.20%/
      )
      await expect(async () => {
        await page.mouse.move(0, 0)
        await gamma.getByRole("button", { name: "Off list" }).hover()
        // Exact, as the Every month caption says it too.
        await expect(
          page.getByText("Sold out or fell below 1%", { exact: true })
        ).toBeVisible({ timeout: 1000 })
      }).toPass()
      await expect(majorHolders(page)).toContainText(
        "Percent of listed shares, scrip included, as IDX publishes it. Holders under 1% are not listed."
      )
    })

    test("splits the month's listed shares among its holders in the ownership bar", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      const segments = majorHolders(page)
        .getByRole("img", { name: "Ownership of listed shares" })
        .locator("> *")
      const legend = majorHolders(page)
        .getByRole("list", { name: "Ownership legend" })
        .getByRole("listitem")
      const expectBar = async (
        bar: ReadonlyArray<readonly [string, string, string]>
      ) => {
        await expect(segments).toHaveCount(bar.length)
        for (const [index, [title, width, tone]] of bar.entries()) {
          const segment = segments.nth(index)
          await expect(segment).toHaveAttribute("title", title)
          await expect(segment).toHaveAttribute("data-tone", tone)
          // The server renders `width:54.94%`, React on the client `width: 54.94%;`.
          expect(
            (await segment.getAttribute("style"))?.replace(/[\s;]/g, "")
          ).toBe(`width:${width}`)
        }
      }
      await expectBar([
        ["PT DWIMURIA INVESTAMA ANDALAN 54.94%", "54.94%", "gold"],
        ["ANTHONI SALIM 1.60%", "1.6%", "gold"],
        ["PT. SALIM GROUP 1.50%", "1.5%", "blue"],
        ["BLACKROCK INC 1.10%", "1.1%", "blue"],
        ["Holders under 1% 40.86%", "40.86%", "under"],
      ])
      await expect(legend).toHaveText([
        "PT DWIMURIA INVESTAMA ANDALAN 54.94%",
        "ANTHONI SALIM 1.60%",
        "PT. SALIM GROUP 1.50%",
        "BLACKROCK INC 1.10%",
        "Under 1% 40.86%",
        "Gold = controller or affiliate",
      ])

      // The bar follows the panel's month tabs.
      await expect(async () => {
        await holdersTab(page, "Aug 2026").click()
        await expect(page).toHaveURL(/holdersMonth=2026-08$/, {
          timeout: 1000,
        })
      }).toPass()
      await expectBar([
        ["PT DWIMURIA INVESTAMA ANDALAN 54.94%", "54.94%", "blue"],
        ["ANTHONI SALIM 1.50%", "1.5%", "blue"],
        ["BLACKROCK INC 1.30%", "1.3%", "blue"],
        ["GAMMA FUND LTD 1.20%", "1.2%", "blue"],
        ["Holders under 1% 41.06%", "41.06%", "under"],
      ])
      await expect(legend.nth(4)).toHaveText("Under 1% 41.06%")
    })

    test("opens the stock's first month with nothing to compare, kept in the URL on reload", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      await expect(async () => {
        await holdersTab(page, "Aug 2026").click()
        await expect(page).toHaveURL(/\/stocks\/BBCA\?holdersMonth=2026-08$/, {
          timeout: 1000,
        })
      }).toPass()
      const firstMonth =
        "4 holders hold 58.94% of listed shares · First month reported, nothing to compare"
      await expect(majorHolders(page)).toContainText(firstMonth)
      await expect(holderRow(page, "GAMMA FUND LTD")).toContainText("1.20%")
      for (const chip of ["New", "Up", "Down", "Unchanged", "Off list"])
        await expect(
          majorHolders(page).getByRole("table", { name: "Major holders" })
        ).not.toContainText(chip)

      await page.reload()
      await expect(holdersTab(page, "Aug 2026")).toHaveAttribute(
        "aria-pressed",
        "true"
      )
      await expect(majorHolders(page)).toContainText(firstMonth)
    })

    test("grids every month's holders, outlining and sorting by the month picked", async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD}/stocks/BBCA`)
      const rows = everyMonthRows(page)
      // Jul has BBRI only, so its column is all dots.
      await expect(rows.first()).toContainText(
        /Holder.*Jul 26\s*Aug 26\s*Sep 26$/
      )
      const outlined = rows.first().locator('th[aria-current="true"]')
      await expect(outlined).toHaveText("Sep 26")
      await expect(rows.nth(1)).toContainText(
        /PT DWIMURIA INVESTAMA ANDALAN.*·54\.9454\.94$/
      )
      // Gamma left the list in Sep: a dot, greyed at the bottom.
      await expect(rows.last()).toContainText(/GAMMA FUND LTD.*1\.20·$/)
      await expect(rows.last()).toHaveAttribute("data-unlisted", "true")

      await expect(async () => {
        await holdersTab(page, "Aug 2026").click()
        await expect(outlined).toHaveText("Aug 26", { timeout: 1000 })
      }).toPass()
      // Salim joined in Sep, so in Aug it is the holder not listed. Its Sep is
      // a first listing, which no mark flags.
      await expect(rows.last()).toContainText(/PT\. SALIM GROUP.*·1\.50$/)
      await expect(rows.last()).toHaveAttribute("data-unlisted", "true")
      await expect(
        rows.filter({ hasText: "GAMMA FUND LTD" })
      ).not.toHaveAttribute("data-unlisted")
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

// BBCA's last 80 trading days before today, with the one 25 trading days
// back never built. Ten brokers buy or sell the same lots every day; over
// the last 10 days NI turns from seller to the biggest buyer and MG the
// other way, so 2W's Top 5 differ from 3M's.
const STEADY = {
  YP: 100,
  PD: 80,
  CC: 60,
  KZ: 40,
  AK: 30,
  BK: -100,
  ZP: -80,
  RX: -60,
  CS: -40,
  DX: -30,
} as const
const TOP_3M = Object.keys(STEADY)
const BROKER_DAYS: ReadonlyArray<SeededDay> = tradingDaysBeforeToday(80)
  .map((day, index) => {
    const late = index >= 70
    const nets: Record<string, number> = {
      ...STEADY,
      NI: late ? 500 : -100,
      MG: late ? -500 : 100,
    }
    return {
      day,
      price: 9_000,
      // The newest day built with 3 of its trades missing.
      missingTrades: index === 79 ? 3 : 0,
      flows: Object.entries(nets).map(([broker, net]) => ({
        broker,
        investorType: broker === "KZ" || broker === "BK" ? "F" : "D",
        buyLots: Math.max(net, 0) + 20,
        sellLots: Math.max(-net, 0) + 20,
      })),
    } satisfies SeededDay
  })
  .filter((_, index) => index !== 55)

const brokerInventory = (page: Page) =>
  page.getByRole("region", { name: "Broker inventory" })

const inventoryChart = (page: Page) =>
  brokerInventory(page).getByRole("img", { name: "Broker inventory chart" })

// The brokers the chart draws a line for, in its order.
const plotted = (page: Page) =>
  inventoryChart(page)
    .locator("[data-broker]")
    .evaluateAll((lines) =>
      lines.map((line) => line.getAttribute("data-broker"))
    )

// The chart's candle bodies, each a link to its day in Market Live.
const candles = (page: Page) =>
  inventoryChart(page).getByRole("link", { name: /in Market Live$/ })

const candleOf = (page: Page, day: string) =>
  candles(page).and(page.locator(`[href$="day=${day}"]`))

const rangePreset = (page: Page, label: string) =>
  brokerInventory(page)
    .getByRole("group", { name: "Range" })
    .getByRole("button", {
      name: label,
      exact: true,
    })

const summaryTable = (page: Page) =>
  brokerInventory(page).getByRole("table", { name: "Broker summary" })

// A summary row, by its broker code.
const summaryRow = (page: Page, broker: string) =>
  summaryTable(page)
    .locator("tbody tr")
    .filter({
      has: page.getByRole("rowheader", { name: new RegExp(`^${broker}`) }),
    })

// A table row's last cell: its Freq.
const freqCell = (row: Locator) => row.locator("td").last()

const chips = (page: Page) =>
  brokerInventory(page).getByRole("list", { name: "Plotted brokers" })

const lensPick = (page: Page, group: string, label: string) =>
  brokerInventory(page)
    .getByRole("group", { name: group })
    .getByRole("button", { name: label, exact: true })

// The hover-day panel and the drag selection's.
const dayPanel = (page: Page) =>
  brokerInventory(page).getByRole("region", { name: "Day", exact: true })

const selectionPanel = (page: Page) =>
  brokerInventory(page).getByRole("region", { name: "Selection", exact: true })

// The middle of `day`'s candle body: the chart's x for that day.
const candleCentre = async (page: Page, day: string) => {
  const box = await candleOf(page, day).boundingBox()
  if (box === null) throw new Error(`no candle for ${day}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// The day a panel's date link opens.
const linkedDay = (side: ReturnType<typeof dayPanel>) =>
  side
    .getByRole("link", { name: /in Market Live$/ })
    .first()
    .getAttribute("href")
    .then((href) => href?.replace(/.*day=/, ""))

test.describe.serial("the Broker inventory tab", () => {
  test.beforeAll(() => {
    seedBrokerTotals("BBCA", BROKER_DAYS)
  })

  test.use({ storageState: MEMBER.storageState })

  test("opens from the tab bar on Top 5 net buy and sell over 3M", async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD}/stocks/BBCA`)
    const tab = page
      .getByRole("tablist", { name: "Stock views" })
      .getByRole("tab", { name: "Broker inventory" })
    await expect(async () => {
      await tab.click()
      await expect(page).toHaveURL(/\?tab=brokers$/, { timeout: 1000 })
    }).toPass()
    await expect(tab).toHaveAttribute("aria-selected", "true")
    await expect(rangePreset(page, "3M")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await expect.poll(() => plotted(page)).toStrictEqual(TOP_3M)
    for (const broker of TOP_3M)
      await expect(
        inventoryChart(page).getByText(broker, { exact: true })
      ).toBeVisible()
    // The day never built is a band the lines cross dotted.
    await expect(inventoryChart(page).locator("[data-gap]")).toHaveCount(1)
    await expect(inventoryChart(page).locator("[data-zero]")).toHaveCount(1)
    await expect(brokerInventory(page)).toContainText(/Today \(.+\) is pending/)
  })

  test("opens from ?tab=brokers and re-ranks for another preset", async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD}/stocks/BBCA?tab=brokers`)
    await expect.poll(() => plotted(page)).toStrictEqual(TOP_3M)
    await expect(async () => {
      await rangePreset(page, "2W").click()
      await expect(page).toHaveURL(/[?&]range=2W/, { timeout: 1000 })
    }).toPass()
    await expect
      .poll(() => plotted(page))
      .toStrictEqual([
        "NI",
        "YP",
        "PD",
        "CC",
        "KZ",
        "MG",
        "BK",
        "ZP",
        "RX",
        "CS",
      ])
    await expect(inventoryChart(page).locator("[data-gap]")).toHaveCount(0)
    await page.reload()
    await expect(rangePreset(page, "2W")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await expect.poll(() => plotted(page)).toContain("NI")
    // Back to the default leaves the range out of the URL.
    // The reload's page may not have hydrated yet.
    await expect(async () => {
      await rangePreset(page, "3M").click()
      await expect(page).toHaveURL(/\/stocks\/BBCA\?tab=brokers$/, {
        timeout: 1000,
      })
    }).toPass()
    await expect.poll(() => plotted(page)).toStrictEqual(TOP_3M)
  })

  test("the investor filter and measure reshape the summary and lines, and a reload keeps them", async ({
    page,
  }) => {
    // 1Y holds all 80 days.
    await page.goto(`${DASHBOARD}/stocks/BBCA?tab=brokers&range=1Y`)
    const rows = summaryTable(page).locator("tbody tr")
    await expect(rows).toHaveCount(12)
    // 69 days of 650 lots and 10 of 1,050, a trade every 5 lots.
    await expect(brokerInventory(page)).toContainText(
      "12 brokers · 55.35 K lots traded · 11.07 K trades counted · regular board + auction matches · 3 trades missing · 1 gap day skipped"
    )
    await expect(summaryRow(page, "YP")).toContainText("+7,900")
    // A trade every 5 lots. YP buys 120 lots a day over 79 days; NI nets
    // a seller, selling 120 a day for 69 days and 20 a day for 10.
    await expect(
      summaryTable(page).getByRole("columnheader", { name: "Freq" })
    ).toBeVisible()
    await expect(freqCell(summaryRow(page, "YP"))).toHaveText("1,896")
    await expect(freqCell(summaryRow(page, "NI"))).toHaveText("1,696")
    await expect(async () => {
      await lensPick(page, "Investor", "Foreign").click()
      await expect(page).toHaveURL(/[?&]investor=foreign/, { timeout: 1000 })
    }).toPass()
    // Only KZ and BK trade for foreign investors.
    await expect.poll(() => plotted(page)).toStrictEqual(["KZ", "BK"])
    await expect(rows).toHaveCount(2)
    await expect(summaryRow(page, "KZ")).toContainText(/^KZ\s*F/)
    // KZ buys 60 lots a day, BK sells 120.
    await expect(freqCell(summaryRow(page, "KZ"))).toHaveText("948")
    await expect(freqCell(summaryRow(page, "BK"))).toHaveText("1,896")
    await lensPick(page, "Measure", "Net value").click()
    await expect(page).toHaveURL(/[?&]measure=value/)
    await expect(
      summaryTable(page).getByRole("columnheader", { name: "Net value" })
    ).toBeVisible()
    // 79 built days of 40 lots at 9,000.
    await expect(summaryRow(page, "KZ")).toContainText("+Rp2.84 B")
    await expect(inventoryChart(page)).toContainText(/ B/)
    await page.reload()
    await expect(lensPick(page, "Investor", "Foreign")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await expect(lensPick(page, "Measure", "Net value")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await expect.poll(() => plotted(page)).toStrictEqual(["KZ", "BK"])
    await expect(summaryRow(page, "KZ")).toContainText("+Rp2.84 B")
  })

  test("adds a broker from its summary row, and its chip's ✕ removes it", async ({
    page,
  }) => {
    // Over 1Y, as over 3M, MG is a net buyer outside the Top 5.
    await page.goto(`${DASHBOARD}/stocks/BBCA?tab=brokers&range=1Y`)
    await expect.poll(() => plotted(page)).toStrictEqual(TOP_3M)
    await expect(async () => {
      await summaryRow(page, "MG").click()
      await expect(page).toHaveURL(/[?&]brokers=buy%2Csell%2CMG/, {
        timeout: 1000,
      })
    }).toPass()
    await expect.poll(() => plotted(page)).toStrictEqual([...TOP_3M, "MG"])
    await expect(
      brokerInventory(page).getByRole("list", { name: "Net buy" })
    ).toContainText("MG")
    await chips(page)
      .getByRole("button", { name: "Remove Top 5 net sell" })
      .click()
    await expect(page).toHaveURL(/[?&]brokers=buy%2CMG/)
    await expect
      .poll(() => plotted(page))
      .toStrictEqual([...TOP_3M.slice(0, 5), "MG"])
    await page.reload()
    await expect
      .poll(() => plotted(page))
      .toStrictEqual([...TOP_3M.slice(0, 5), "MG"])
    await expect(async () => {
      await chips(page).getByRole("button", { name: "Remove MG" }).click()
      await expect(page).toHaveURL(/[?&]brokers=buy$/, { timeout: 1000 })
    }).toPass()
    await expect.poll(() => plotted(page)).toStrictEqual(TOP_3M.slice(0, 5))
    await chips(page).getByRole("button", { name: "Top 5 net sell" }).click()
    // Both groups again are the default, left out of the URL.
    await expect(page).toHaveURL(/\/stocks\/BBCA\?tab=brokers&range=1Y$/)
    await expect.poll(() => plotted(page)).toStrictEqual(TOP_3M)
  })

  test("keeps no chips as an empty list", async ({ page }) => {
    await page.goto(`${DASHBOARD}/stocks/BBCA?tab=brokers&brokers=`)
    await expect(summaryTable(page).locator("tbody tr")).toHaveCount(12)
    await expect.poll(() => plotted(page)).toStrictEqual([])
    await page.reload()
    await expect(page).toHaveURL(/[?&]brokers=$/)
    await expect.poll(() => plotted(page)).toStrictEqual([])
  })

  test("opens a candle's day in Market Live, and Back restores the view", async ({
    page,
  }) => {
    const newest = BROKER_DAYS.at(-1)?.day ?? ""
    const gap = tradingDaysBeforeToday(80)[55] ?? ""
    await page.goto(`${DASHBOARD}/stocks/BBCA?tab=brokers`)
    // 3M's built days each have a candle and a volume bar; its gap has none.
    await expect(candleOf(page, newest)).toHaveCount(1)
    const built = await candles(page).count()
    await expect(inventoryChart(page).locator("[data-volume]")).toHaveCount(
      built
    )
    await expect(inventoryChart(page).locator("[data-gap]")).toHaveCount(1)
    await expect(candleOf(page, gap)).toHaveCount(0)
    await expect(async () => {
      await rangePreset(page, "2W").click()
      await expect(page).toHaveURL(/[?&]range=2W/, { timeout: 1000 })
    }).toPass()
    await expect.poll(() => plotted(page)).toContain("NI")
    const shown = await candles(page).count()
    const twoWeeks = await plotted(page)
    await candleOf(page, newest).click()
    await expect(page).toHaveURL(
      `${DASHBOARD}/market-live?code=BBCA&day=${newest}`
    )
    await page.goBack()
    await expect(page).toHaveURL(
      `${DASHBOARD}/stocks/BBCA?tab=brokers&range=2W`
    )
    await expect(rangePreset(page, "2W")).toHaveAttribute(
      "aria-pressed",
      "true"
    )
    await expect.poll(() => plotted(page)).toStrictEqual(twoWeeks)
    await expect(candles(page)).toHaveCount(shown)
  })

  test("hovering reads a day; a click on empty space pins it, Esc or another click unpins, and the URL never changes", async ({
    page,
  }) => {
    const days = tradingDaysBeforeToday(80)
    const [first = "", second = "", third = ""] = [days[60], days[65], days[70]]
    const url = `${DASHBOARD}/stocks/BBCA?tab=brokers&range=1Y`
    await page.goto(url)
    // With nothing hovered, the newest day.
    await expect.poll(() => linkedDay(dayPanel(page))).toBe(days.at(-1))
    // Above a candle: empty space, whatever the lines cross there.
    const above = async (day: string) => {
      const { x, y } = await candleCentre(page, day)
      return { x, y: y - 40 }
    }
    let empty = { x: 0, y: 0 }
    await expect(async () => {
      // Measured each try: until the page hydrates, the chart is drawn at
      // its default width.
      empty = await above(first)
      await page.mouse.move(empty.x - 2, empty.y)
      await page.mouse.move(empty.x, empty.y)
      await expect
        .poll(() => linkedDay(dayPanel(page)), { timeout: 1000 })
        .toBe(first)
    }).toPass()
    // YP buys a steady 100 lots a day: day 60 is its 60th built day, 0 to 59
    // less the gap at 55, so 60 × 100 by then.
    await expect(
      dayPanel(page)
        .getByRole("row")
        .filter({ has: page.getByRole("rowheader", { name: "YP" }) })
        .getByRole("cell")
    ).toHaveText(["+6,000", "+100", "9,000", "9,000"])
    await page.mouse.click(empty.x, empty.y)
    await expect(dayPanel(page)).toContainText("Pinned")
    await expect(
      inventoryChart(page).locator('[data-marker="pinned"]')
    ).toHaveCount(1)
    const elsewhere = await above(second)
    await page.mouse.move(elsewhere.x, elsewhere.y)
    await expect.poll(() => linkedDay(dayPanel(page))).toBe(first)
    await page.keyboard.press("Escape")
    await expect(dayPanel(page)).not.toContainText("Pinned")
    await page.mouse.move(elsewhere.x + 1, elsewhere.y)
    await expect.poll(() => linkedDay(dayPanel(page))).toBe(second)
    // Another click unpins too.
    await page.mouse.click(elsewhere.x, elsewhere.y)
    await expect(dayPanel(page)).toContainText("Pinned")
    const last = await above(third)
    await page.mouse.click(last.x, last.y)
    await expect(dayPanel(page)).not.toContainText("Pinned")
    await expect(page).toHaveURL(url)
  })

  test("a drag selects days, a reload keeps them, and a date opens Market Live with Back restoring them", async ({
    page,
  }) => {
    const days = tradingDaysBeforeToday(80)
    const [from = "", to = ""] = [days[60], days[69]]
    await page.goto(`${DASHBOARD}/stocks/BBCA?tab=brokers&range=1Y`)
    await expect(candleOf(page, from)).toHaveCount(1)
    // From one candle's body to another's: a drag, which opens neither.
    await expect(async () => {
      const start = await candleCentre(page, from)
      const end = await candleCentre(page, to)
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(end.x, end.y, { steps: 8 })
      await page.mouse.up()
      await expect(page).toHaveURL(
        new RegExp(`[?&]selFrom=${from}&selTo=${to}`),
        { timeout: 1000 }
      )
    }).toPass()
    await expect(page).toHaveURL(/\/stocks\/BBCA\?/)
    const selection = selectionPanel(page)
    await expect(selection).toContainText("10 days")
    await expect(selection).toContainText("0.00%")
    await expect(inventoryChart(page).locator("[data-selection]")).toHaveCount(
      1
    )
    const rows = selection.locator("tbody tr")
    await expect(rows).toHaveCount(10)
    // By net over the 10 days: YP's steady 100 a day first, BK's −100 last.
    await expect(rows.first()).toContainText("YP+1,000")
    await expect(rows.last()).toContainText("BK−1,000")
    // Every lot the plotted brokers bought, one of them sold: the Top 5
    // each side net out to 0 over these days.
    await expect(selection.locator("tfoot")).toContainText("Total0")
    // YP's buys and BK's sells, a trade every 5 lots.
    await expect(freqCell(rows.first())).toHaveText("240")
    await expect(freqCell(rows.last())).toHaveText("240")
    await page.reload()
    await expect(selectionPanel(page)).toContainText("10 days")
    await expect.poll(() => linkedDay(selectionPanel(page))).toBe(from)
    await expect(async () => {
      await selectionPanel(page)
        .getByRole("link", { name: /in Market Live$/ })
        .first()
        .click()
      await expect(page).toHaveURL(
        `${DASHBOARD}/market-live?code=BBCA&day=${from}`,
        { timeout: 1000 }
      )
    }).toPass()
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`[?&]selFrom=${from}&selTo=${to}`))
    await expect(selectionPanel(page)).toContainText("10 days")
    // Back may reload the page, which may not have hydrated yet.
    await expect(async () => {
      await selectionPanel(page).getByRole("button", { name: "Clear" }).click()
      await expect(page).toHaveURL(
        `${DASHBOARD}/stocks/BBCA?tab=brokers&range=1Y`,
        { timeout: 1000 }
      )
    }).toPass()
    await expect(selectionPanel(page)).toHaveCount(0)
  })

  test("a link whose selection falls outside the range drops it from the URL", async ({
    page,
  }) => {
    const days = tradingDaysBeforeToday(80)
    // 2W holds only the newest days; these are months back.
    const [from = "", to = ""] = [days[10], days[19]]
    await page.goto(
      `${DASHBOARD}/stocks/BBCA?tab=brokers&range=2W&selFrom=${from}&selTo=${to}`
    )
    await expect(page).toHaveURL(
      `${DASHBOARD}/stocks/BBCA?tab=brokers&range=2W`
    )
    await expect(selectionPanel(page)).toHaveCount(0)
  })
})
