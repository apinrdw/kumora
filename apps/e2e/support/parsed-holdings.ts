// The parsed holdings the Holder moves and Holder map specs read: the
// dashboard's trimmed report fixtures, archived as an archive run would and
// parsed by the admin's Parse now.
import type { Page } from "@playwright/test"

import { expect } from "./test"

import { DASHBOARD } from "./accounts"
import { seedAbove1Months, seedAbove5Days } from "./holdings"
import { seedReportFixture } from "./shareholding"

const SHAREHOLDING = `${DASHBOARD}/admin/shareholding`

// Later than the shareholding admin spec's fixtures, so each day's newest
// version is these: its 20 Nov 2026 is BIKE alone.
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

// The trimmed above-1% fixtures.
const ABOVE_1_MONTHS = [
  "2026-02-27",
  "2026-04-30",
  "2026-08-31",
  "2026-09-30",
  "2026-10-30",
]

/**
 * Empties the parsed above-1% months and above-5% days, then archives every
 * fixture the parse runs read, so they parse into these alone.
 */
export async function seedHoldingsFixtures() {
  // The stocks spec seeds parsed periods no archive holds, which a parse
  // keeps: its Jul 2026, with no TRUE rows, made TRUE's Aug a gap after
  // Apr, so no move, Djoni's Off list among them, was derived for it.
  seedAbove1Months({})
  seedAbove5Days({})
  for (const month of INVESTOR_TYPE_MONTHS)
    await seedReportFixture(
      "investor-type",
      `investor-type-${month}.xlsx`,
      month,
      FETCHED_AT
    )
  for (const day of ABOVE_5_DAYS)
    await seedReportFixture("above-5", `above-5-${day}.xlsx`, day, FETCHED_AT)
  for (const month of ABOVE_1_MONTHS)
    await seedReportFixture(
      "above-1",
      `above-1-${month}.xlsx`,
      month,
      FETCHED_AT
    )
}

const parseCard = (page: Page, kind: string) =>
  page.getByRole("region", { name: new RegExp(`Last ${kind} parse run`) })

/** Presses the card's Parse now and waits for that run to end Complete. */
export async function parseNow(page: Page, kind: string) {
  await page.goto(SHAREHOLDING)
  await parseCard(page, kind).getByRole("button", { name: "Parse now" }).click()
  await expect(parseCard(page, kind)).toContainText(/Started admin-\d+\./)
  // The run ends on its own; the page shows it once reloaded.
  await expect(async () => {
    await page.reload()
    await expect(parseCard(page, kind)).toContainText("Complete", {
      timeout: 1000,
    })
  }).toPass({ timeout: 25_000 })
  // Outside the reload loop: the button stays disabled until the page
  // hydrates, which under load takes longer than one retry's second.
  await expect(
    parseCard(page, kind).getByRole("button", { name: "Parse now" })
  ).toBeEnabled()
}
