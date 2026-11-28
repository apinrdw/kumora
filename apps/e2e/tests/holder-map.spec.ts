import type { Locator, Page } from "@playwright/test"

import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"
import { parseNow, seedHoldingsFixtures } from "../support/parsed-holdings"

const HOLDER_MAP = `${DASHBOARD}/holder-map`

const search = (page: Page) => page.getByRole("combobox", { name: "Focus" })

const band = (page: Page, name: "5% and above" | "1% to 5%") =>
  page.getByRole("table", { name }).locator("tbody tr")

// The map's chart, named by its focus and how many holders and Off list
// holders it draws; never its pixels. Off list left out matches any, and
// the hop beyond any unless named.
const mapOf = (
  page: Page,
  code: string,
  holders?: number,
  offList?: number,
  beyond?: string
) =>
  page.getByRole("img", {
    name:
      holders === undefined
        ? new RegExp(`^Holder map of ${code}: `)
        : offList === undefined
          ? new RegExp(
              `^Holder map of ${code}: ${holders} holders( and \\d+ Off list)?(, [^.]* a hop beyond)?\\. `
            )
          : `Holder map of ${code}: ${holders} holders${offList === 0 ? "" : ` and ${offList} Off list`}${beyond === undefined ? "" : `, ${beyond} a hop beyond`}. The tables below list each.`,
  })

const BPJS = "DJS KETENAGAKERJAAN PROGRAM JAMINAN HARI TUA"
// Its holder key in the URL, spaces encoded either way.
const BPJS_PARAM = /holder=DJS(%20|\+)HARI(%20|\+)JAMINAN/

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
      const map = mapOf(page, "TRUE", 4, 2)
      await expect(map).toBeVisible()
      await expect(
        page.getByRole("list", { name: "Legend" }).getByRole("listitem")
      ).toHaveText([
        /^Stock/,
        /^Holder/,
        // Mirae, the custodian of both its above-5% holders.
        /^Custodian/,
        /^5% and above/,
        /^1% to 5%/,
        /^Local/,
        // The links' moves: Perintis down on the day, the rest unchanged,
        // and the dashed Off list.
        /^Down/,
        /^Unchanged/,
        /^Off list/,
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
      // The map draws them too, faded, until the toggle hides both.
      await expect(mapOf(page, "TRUE", 4, 2)).toBeVisible()
      const toggle = page.getByRole("button", { name: /^Show Off list/ })
      await expect(toggle).toHaveAttribute("aria-pressed", "true")
      await until(
        () => toggle.click(),
        () => expect(offList).toHaveCount(0, { timeout: 1000 })
      )
      await expect(mapOf(page, "TRUE", 4, 0)).toBeVisible()
      // A filter, kept in the URL, and across a refocus.
      await expect(page).toHaveURL(/offList=hide/)
      await toggle.click()
      await expect(offList.getByRole("listitem")).toHaveCount(2)
      await expect(mapOf(page, "TRUE", 4, 2)).toBeVisible()
      await expect(page).not.toHaveURL(/offList=/)
      await page.goBack()
      await expect(page).toHaveURL(/offList=hide/)
      await expect(offList).toHaveCount(0)

      // The URL alone hides it, and a refocus keeps it hidden.
      await page.goto(`${HOLDER_MAP}?stock=TRUE&day=2026-11-20&offList=hide`)
      await expect(mapOf(page, "TRUE", 4, 0)).toBeVisible()
      await expect(toggle).toHaveAttribute("aria-pressed", "false")
      await until(
        () =>
          band(page, "5% and above")
            .getByRole("link", { name: "PT AGUNG PERKASA INVESTINDO" })
            .click(),
        () => expect(page).toHaveURL(/holder=/, { timeout: 1000 })
      )
      await expect(page).toHaveURL(/offList=hide/)
    })

    test("lists the hop beyond in the side panel, each end refocusing the map", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MAP}?stock=BSDE&day=2026-11-20`)
      await expect(mapOf(page, "BSDE", 7, 4, "1 other stock")).toBeVisible()
      // BPJS's other stock, TLKM: the ring stock the map draws.
      const beyond = page
        .getByRole("table", { name: "Its holders' other stocks" })
        .locator("tbody tr")
      await expect(beyond).toHaveCount(1)
      await expect(beyond).toContainText(
        new RegExp(`${BPJS}\\s*TLKM\\s*TELKOM INDONESIA.*2\\.40%`)
      )
      await until(
        () => beyond.getByRole("link", { name: "TLKM" }).click(),
        () =>
          expect(page).toHaveURL(
            /\/holder-map\?(?=.*stock=TLKM)(?=.*day=2026-11-20)/,
            { timeout: 1000 }
          )
      )

      // A holder focus lists its stocks' other holders: BSDE's six and
      // TLKM's four.
      await page.goto(
        `${HOLDER_MAP}?holder=${encodeURIComponent("DJS HARI JAMINAN KETENAGAKERJAAN PROGRAM TUA")}&day=2026-11-20`
      )
      await expect(
        page
          .getByRole("table", { name: "Its stocks' other holders" })
          .locator("tbody tr")
      ).toHaveCount(10)
    })

    test("labels a searched node the map draws in place, and refocuses on one it doesn't", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MAP}?stock=BSDE&day=2026-11-20`)
      await expect(mapOf(page, "BSDE", 7, 4, "1 other stock")).toBeVisible()
      // TLKM rings the map: picking it labels it, and keeps the focus.
      await pick(page, "TLKM", page.getByRole("option", { name: /^TLKM/ }))
      const note = page.getByText("is labelled on the map.")
      await expect(note).toContainText("TLKM is labelled on the map.")
      await expect(page).toHaveURL(/stock=BSDE/)
      await page.getByRole("button", { name: "Clear" }).click()
      await expect(note).toHaveCount(0)

      await pick(page, "TLKM", page.getByRole("option", { name: /^TLKM/ }))
      await page.getByRole("button", { name: "Focus it" }).click()
      await expect(page).toHaveURL(
        /\/holder-map\?(?=.*stock=TLKM)(?=.*day=2026-11-20)/
      )
      // TRUE isn't on TLKM's map: picking it refocuses.
      await pick(page, "TRUE", page.getByRole("option", { name: /^TRUE/ }))
      await expect(page).toHaveURL(/stock=TRUE/)
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

    test("keeps the picked day on the stocks most held", async ({ page }) => {
      await page.goto(`${HOLDER_MAP}?day=2026-11-19`)
      const first = page
        .getByRole("list", { name: "Most held stocks" })
        .getByRole("link")
        .first()
      const code = (await first.innerText()).split(/\s/)[0] ?? ""
      await first.click()
      await expect(page).toHaveURL(
        new RegExp(`/holder-map\\?(?=.*stock=${code})(?=.*day=2026-11-19)`)
      )
      await expect(
        page.getByRole("combobox", { name: "Trading day" })
      ).toHaveValue("2026-11-19")
      await expect(mapOf(page, code)).toBeVisible()
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

    test("focuses a holder through the search, its stocks and their other holders drawn", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MAP}?day=2026-11-20`)
      await pick(
        page,
        "jaminan hari",
        page.getByRole("option", { name: new RegExp(`^${BPJS}\\s*Holder`) })
      )
      await expect(page).toHaveURL(BPJS_PARAM)
      await expect(page).toHaveURL(/day=2026-11-20/)
      await expect(page).not.toHaveURL(/stock=/)
      await expect(
        page.getByRole("heading", { name: `${BPJS} Holder` })
      ).toBeVisible()
      // Its stocks in Oct's report, each with its issuer.
      await expect(band(page, "1% to 5%")).toHaveCount(2)
      await expect(band(page, "1% to 5%").nth(0)).toContainText(
        /BSDE\s*BUMI SERPONG DAMAI Tbk.*2\.70%/
      )
      await expect(band(page, "1% to 5%").nth(1)).toContainText(
        /TLKM\s*TELKOM INDONESIA \(PERSERO\) Tbk.*2\.40%/
      )
      await expect(
        page.getByRole("region", { name: "1% to 5%" })
      ).toContainText("2 stocks · 5.10% · Oct 2026")
      // BSDE's six other ≥1% holders and TLKM's four.
      await expect(
        page.getByRole("img", {
          name: `Holder map of ${BPJS}: 2 stocks, 10 other holders a hop beyond. The tables below list each.`,
        })
      ).toBeVisible()
    })

    test("refocuses from a holder to its stocks and back through the side panel and the URL", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MAP}?stock=BSDE&day=2026-11-20`)
      // BPJS's other stock, TLKM, rings the map.
      await expect(mapOf(page, "BSDE", 7, 4, "1 other stock")).toBeVisible()
      await until(
        () => band(page, "1% to 5%").getByRole("link", { name: BPJS }).click(),
        () => expect(page).toHaveURL(BPJS_PARAM, { timeout: 1000 })
      )
      await expect(page).toHaveURL(/day=2026-11-20/)
      await expect(page).not.toHaveURL(/stock=/)
      await expect(
        page.getByRole("heading", { name: `${BPJS} Holder` })
      ).toBeVisible()

      await band(page, "1% to 5%").getByRole("link", { name: "TLKM" }).click()
      await expect(page).toHaveURL(
        /\/holder-map\?(?=.*stock=TLKM)(?=.*day=2026-11-20)/
      )
      await expect(page).not.toHaveURL(/holder=/)
      await expect(
        page.getByRole("heading", { name: /^TLKM TELKOM/ })
      ).toBeVisible()

      // Back and forward restore each focus.
      await page.goBack()
      await expect(page).toHaveURL(BPJS_PARAM)
      await expect(
        page.getByRole("heading", { name: `${BPJS} Holder` })
      ).toBeVisible()
      await page.goBack()
      await expect(page).toHaveURL(/stock=BSDE/)
      await page.goForward()
      await expect(page).toHaveURL(BPJS_PARAM)

      // The URL alone focuses a holder; naming a stock too names neither.
      await page.goto(
        `${HOLDER_MAP}?holder=${encodeURIComponent("DJS HARI JAMINAN KETENAGAKERJAAN PROGRAM TUA")}`
      )
      await expect(
        page.getByRole("heading", { name: `${BPJS} Holder` })
      ).toBeVisible()
      await page.goto(`${HOLDER_MAP}?stock=TRUE&holder=DJONI`)
      await expect(
        page.getByRole("heading", { name: /^Stocks with the most ≥1% holders/ })
      ).toBeVisible()
    })

    test("refocuses on a ring stock picked on the map with the keyboard", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MAP}?stock=BSDE&day=2026-11-20`)
      const map = mapOf(page, "BSDE", 7, 4, "1 other stock")
      await expect(map).toBeVisible()
      await map.focus()
      // The arrow keys step through the nodes until the tooltip names TLKM.
      await expect(async () => {
        await page.keyboard.press("ArrowRight")
        await expect(page.getByRole("status")).toContainText("TLKM", {
          timeout: 200,
        })
      }).toPass()
      await page.keyboard.press("Enter")
      await expect(page).toHaveURL(
        /\/holder-map\?(?=.*stock=TLKM)(?=.*day=2026-11-20)/
      )
    })

    test("refocuses on a node picked with the keyboard after the map was panned", async ({
      page,
    }) => {
      await page.goto(`${HOLDER_MAP}?stock=BSDE&day=2026-11-20`)
      const map = mapOf(page, "BSDE", 7, 4, "1 other stock")
      await expect(map).toBeVisible()
      const box = await map.boundingBox()
      if (box === null) throw new Error("no map box")
      const x = box.x + box.width / 2
      const y = box.y + 20
      // A pan, released as a drag is.
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 60, y, { steps: 5 })
      await page.mouse.up()
      // A pan the browser cancels, so no click ends it.
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 60, y, { steps: 5 })
      await map.dispatchEvent("pointercancel")
      await page.mouse.up()
      await expect(page).toHaveURL(/\/holder-map\?(?=.*stock=BSDE)/)
      await map.focus()
      await expect(async () => {
        await page.keyboard.press("ArrowRight")
        await expect(page.getByRole("status")).toContainText("TLKM", {
          timeout: 200,
        })
      }).toPass()
      await page.keyboard.press("Enter")
      await expect(page).toHaveURL(
        /\/holder-map\?(?=.*stock=TLKM)(?=.*day=2026-11-20)/
      )
    })

    test("focuses a custodian from a stock's side panel, the search and the URL", async ({
      page,
    }) => {
      const MIRAE = "MIRAE ASSET SEKURITAS INDONESIA"
      const heading = page.getByRole("heading", {
        name: `${MIRAE} Custodian · YP`,
      })
      await page.goto(`${HOLDER_MAP}?stock=TRUE&day=2026-11-20`)
      // Both of TRUE's above-5% holders hold through Mirae, broker YP.
      const custodians = page.getByRole("table", { name: "Custodians" })
      await expect(custodians.locator("tbody tr")).toHaveCount(1)
      await expect(custodians).toContainText(/YP\s*2\s*45,259,395\.84/)
      await expect(
        page.getByRole("list", { name: "Legend" }).getByText("Custodian")
      ).toBeVisible()
      await until(
        () => custodians.getByRole("link", { name: MIRAE }).click(),
        () => expect(page).toHaveURL(/custodian=YP/, { timeout: 1000 })
      )
      await expect(page).toHaveURL(/day=2026-11-20/)
      await expect(page).not.toHaveURL(/stock=/)
      await expect(heading).toBeVisible()
      // Its book: the two holders, and TRUE, with the lots held through it.
      await expect(
        page
          .getByRole("table", { name: "Holders through it" })
          .locator("tbody tr")
      ).toHaveCount(2)
      const stocks = page
        .getByRole("table", { name: "Stocks through it" })
        .locator("tbody tr")
      await expect(stocks).toHaveCount(1)
      await expect(stocks).toContainText(/TRUE.*2\s*45,259,395\.84/)
      await expect(
        page.getByRole("img", {
          name: `Holder map of ${MIRAE}: 2 holders, in 1 stock. The tables below list each.`,
        })
      ).toBeVisible()

      // Its stock refocuses the map; back and forward restore each focus.
      await stocks.getByRole("link", { name: "TRUE" }).click()
      await expect(page).toHaveURL(
        /\/holder-map\?(?=.*stock=TRUE)(?=.*day=2026-11-20)/
      )
      await expect(page).not.toHaveURL(/custodian=/)
      await page.goBack()
      await expect(page).toHaveURL(/custodian=YP/)
      await expect(heading).toBeVisible()
      await page.goBack()
      await expect(page).toHaveURL(/stock=TRUE/)
      await expect(page).not.toHaveURL(/custodian=/)
      await page.goForward()
      await expect(page).toHaveURL(/custodian=YP/)
      await expect(heading).toBeVisible()

      // The search finds it by its broker code.
      await page.goto(`${HOLDER_MAP}?stock=ASRI`)
      await pick(
        page,
        "yp",
        page.getByRole("option", { name: new RegExp(`^${MIRAE}`) })
      )
      await expect(page).toHaveURL(/\/holder-map\?custodian=YP$/)
      await expect(heading).toBeVisible()

      // Naming a custodian and a stock names neither.
      await page.goto(`${HOLDER_MAP}?custodian=YP&stock=TRUE`)
      await expect(
        page.getByRole("heading", { name: /^Stocks with the most ≥1% holders/ })
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
