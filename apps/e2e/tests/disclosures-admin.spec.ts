import type { Locator, Page } from "@playwright/test"

import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"
import {
  seedDisclosureRun,
  seedLatestDisclosureRun,
  type SeededDisclosureRun,
} from "../support/disclosures"

const DISCLOSURES = `${DASHBOARD}/admin/disclosures`

const COMPLETE: SeededDisclosureRun = {
  id: "admin-1795662000000",
  trigger: "admin",
  startedAt: "2026-11-26T03:00:00.000Z",
  finishedAt: "2026-11-26T03:04:30.000Z",
  outcome: "complete",
  days: ["2026-11-26", "2026-11-25"],
  versionsAdded: 380,
  attachmentsStored: 612,
  attachmentsWaiting: 0,
  notStored: [],
  error: null,
}

const PARTIAL: SeededDisclosureRun = {
  ...COMPLETE,
  id: "admin-1795662060000",
  outcome: "partial",
  attachmentsStored: 611,
  attachmentsWaiting: 1,
  notStored: [
    {
      disclosure: "20261126090000-B/3",
      path: "/StaticData/NewsAndAnnouncement/ANNOUNCEMENTSTOCK/From_EREP/202611/b3.pdf",
      message: "IDX answered 503",
    },
  ],
}

const LISTING_ERROR =
  "IDX's disclosures of 2026-11-26 (id) answered 500 (https://www.idx.id/primary/ListedCompany/GetAnnouncement?pageSize=500)"

const FAILED: SeededDisclosureRun = {
  ...COMPLETE,
  id: "admin-1795662120000",
  outcome: "failed",
  versionsAdded: 0,
  attachmentsStored: 0,
  error: LISTING_ERROR,
}

const DAY = 86_400_000

// A run that started `ago` ms before now, named like Run now's runs.
const runAgo = (
  ago: number,
  run: Partial<SeededDisclosureRun>
): SeededDisclosureRun => {
  const started = Math.floor((Date.now() - ago) / 1000) * 1000
  return {
    ...COMPLETE,
    id: `admin-${started}`,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(started + 60_000).toISOString(),
    ...run,
  }
}

const lastRunCard = (page: Page) =>
  page.getByRole("region", { name: /Last disclosure run/ })

// A count on the card, by its label: the dt and dd pair in the counts' dl.
const stat = (card: Locator, label: string) =>
  card
    .locator("dl > div")
    .filter({
      has: card.page().getByRole("term").getByText(label, { exact: true }),
    })
    .getByRole("definition")

test.describe("a member", () => {
  test.use({ storageState: MEMBER.storageState })

  test("gets no Disclosures entry and the not-found page", async ({ page }) => {
    const response = await page.goto(DISCLOSURES)
    expect(response?.status()).toBe(404)
    await expect(
      page.getByRole("heading", { name: "Halaman tidak ditemukan" })
    ).toBeVisible()
    await expect(page.getByRole("link", { name: "Disclosures" })).toHaveCount(0)
  })
})

// Serial, since each test makes its own run the last one.
test.describe.serial("an admin's Disclosures page", () => {
  test.use({ storageState: ADMIN.storageState })

  test("a complete run shows its pill, times and counts", async ({ page }) => {
    await seedLatestDisclosureRun(COMPLETE)
    await page.goto(DASHBOARD)
    await page.getByRole("link", { name: "Disclosures" }).click()
    await expect(page).toHaveURL(DISCLOSURES)
    await expect(page).toHaveTitle("Disclosures · KUMORA Terminal")
    await expect(
      page.getByRole("heading", { name: "Disclosures", level: 1 })
    ).toBeVisible()
    const card = lastRunCard(page)
    await expect(card).toContainText("Complete")
    await expect(card).toContainText("Started Nov 26, 10:00 WIB")
    await expect(card).toContainText("took 4 min 30 s")
    await expect(card).toContainText(COMPLETE.id)
    await expect(stat(card, "Versions added")).toHaveText("380")
    await expect(stat(card, "Attachments stored")).toHaveText("612")
    await expect(stat(card, "Attachments waiting")).toHaveText("0")
    await expect(card.getByRole("button", { name: "Run now" })).toBeEnabled()
  })

  test("a partial run names the attachments it couldn't store", async ({
    page,
  }) => {
    await seedLatestDisclosureRun(PARTIAL)
    await page.goto(DISCLOSURES)
    const card = lastRunCard(page)
    await expect(card).toContainText("Partial")
    await expect(stat(card, "Attachments waiting")).toHaveText("1")
    await expect(card).toContainText(
      "1 attachment waits for the next run. Some could not be downloaded:"
    )
    await expect(
      card.getByRole("list", { name: "Not stored" }).getByRole("listitem")
    ).toHaveText([
      `${PARTIAL.notStored[0]?.path} (20261126090000-B/3): IDX answered 503`,
    ])
  })

  test("a failed run shows IDX's answer", async ({ page }) => {
    await seedLatestDisclosureRun(FAILED)
    await page.goto(DISCLOSURES)
    await expect(lastRunCard(page)).toContainText("Failed")
    await expect(lastRunCard(page).getByRole("alert")).toContainText(
      `Run failed: ${LISTING_ERROR}`
    )
  })

  test("Run now is disabled while the latest run is running", async ({
    page,
  }) => {
    // In progress only while its start is within START_WINDOW_MS: the Test
    // stage holds no Workflow instance for it.
    await seedLatestDisclosureRun(
      runAgo(0, {
        finishedAt: null,
        outcome: "running",
        days: [],
        versionsAdded: 0,
        attachmentsStored: 0,
      })
    )
    await page.goto(DISCLOSURES)
    const card = lastRunCard(page)
    await expect(card).toContainText("Running")
    await expect(card).toContainText("A run is in progress")
    await expect(card.getByRole("button", { name: "Run now" })).toBeDisabled()
  })
})

// These seed runs without changing the last run, so they run beside the
// serial tests above.
test.describe("an admin's disclosure run history", () => {
  test.use({ storageState: ADMIN.storageState })

  test("the recent runs table lists the past 30 days", async ({ page }) => {
    const partial = runAgo(1 * DAY, {
      outcome: "partial",
      versionsAdded: 12,
      attachmentsStored: 20,
    })
    const complete = runAgo(2 * DAY, {
      versionsAdded: 7,
      attachmentsStored: 9,
    })
    const old = runAgo(40 * DAY, {})
    for (const run of [old, complete, partial]) await seedDisclosureRun(run)

    await page.goto(DISCLOSURES)
    const table = page.getByRole("table", { name: "Recent runs" })
    await expect(
      table.getByRole("row").filter({ hasText: partial.id })
    ).toContainText("Partial1220")
    await expect(
      table.getByRole("row").filter({ hasText: complete.id })
    ).toContainText("Complete79")
    await expect(
      table.getByRole("row").filter({ hasText: old.id })
    ).toHaveCount(0)
  })
})
