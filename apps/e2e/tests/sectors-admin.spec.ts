import type { Page } from "@playwright/test"

import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD } from "../support/accounts"
import { seedStockSectors } from "../support/holdings"

const SHAREHOLDING = `${DASHBOARD}/admin/shareholding`

const sectorsCard = (page: Page) =>
  page.getByRole("region", { name: "Sectors" })

const shownRows = async (page: Page) =>
  Number(
    await sectorsCard(page)
      .locator("div")
      .filter({
        has: page.getByRole("term").getByText("Rows", { exact: true }),
      })
      .getByRole("definition")
      .textContent()
  )

// A code no other spec seeds, so this spec's row is its own.
const unseededCode = () =>
  `Z${Array.from({ length: 3 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26))
  ).join("")}`

test.use({ storageState: ADMIN.storageState })

// Decision: the card's Run now is never clicked here: it reads IDX's company
// profiles from the Worker, which Playwright can't stub, and the Test stage
// has no stand-in for IDX. The unit tests (apps/dashboard/tests/server/admin/
// sectors.test.ts) run it against a stub HttpClient.
test("the Sectors card counts stock_sector's rows and offers Run now", async ({
  page,
}) => {
  await page.goto(SHAREHOLDING)
  const card = sectorsCard(page)
  await expect(card).toBeVisible()
  await expect(card.getByRole("button", { name: "Run now" })).toBeEnabled()
  await expect(card).toContainText(
    "Production fills stock_sector from IDX's company profiles at 22:00 WIB."
  )
  const before = await shownRows(page)

  // Specs running at once share stock_sector, so a seeded row only adds.
  seedStockSectors({ [unseededCode()]: "Energy" })
  await page.reload()
  await expect(card.getByRole("button", { name: "Run now" })).toBeEnabled()
  expect(await shownRows(page)).toBeGreaterThanOrEqual(before + 1)
  // Every seeded row carries the same fetched_at.
  await expect(card).toContainText("Nov 16, 22:00 WIB")
})
