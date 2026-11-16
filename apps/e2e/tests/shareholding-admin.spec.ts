import type { Locator, Page } from "@playwright/test"

import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"
import {
  seedLatestRun,
  seedReport,
  seedReportFixture,
  seedRun,
  type SeededRun,
} from "../support/shareholding"

const SHAREHOLDING = `${DASHBOARD}/admin/shareholding`

const COMPLETE: SeededRun = {
  id: "cron-2026-11-14T13",
  trigger: "cron",
  startedAt: "2026-11-14T13:00:00.000Z",
  finishedAt: "2026-11-14T13:01:12.000Z",
  outcome: "complete",
  reportsAdded: 2,
  newVersions: 1,
  reportsChecked: 147,
  notStored: [],
  other: [],
  error: null,
}

const NOT_STORED =
  "https://www.idx.co.id/Media/x7qp21ab/peng-2026-11-13-00117-lima-persen.xlsx"
const OTHER = "https://www.idx.co.id/Media/k2m9/pengumuman-lain.xlsx"
const PARTIAL: SeededRun = {
  ...COMPLETE,
  id: "admin-1763025544000",
  trigger: "admin",
  finishedAt: "2026-11-14T13:06:40.000Z",
  outcome: "partial",
  reportsAdded: 1,
  newVersions: 0,
  notStored: [NOT_STORED],
  other: [{ sourceUrl: OTHER, description: "Laporan Kepemilikan Lainnya" }],
}

const FAILED: SeededRun = {
  ...COMPLETE,
  id: "cron-2026-11-13T06",
  startedAt: "2026-11-13T06:00:00.000Z",
  finishedAt: "2026-11-13T06:00:34.000Z",
  outcome: "failed",
  reportsAdded: 0,
  newVersions: 0,
  reportsChecked: 0,
  error: "www.idx.id answered 403 for the shareholding report list",
}

const DAY = 86_400_000

// A run that started `ago` ms before now, named like Run now's runs.
const runAgo = (ago: number, run: Partial<SeededRun>): SeededRun => {
  const started = Math.floor((Date.now() - ago) / 1000) * 1000
  return {
    ...COMPLETE,
    id: `admin-${started}`,
    trigger: "admin",
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(started + 60_000).toISOString(),
    ...run,
  }
}

const lastRunCard = (page: Page) =>
  page.getByRole("region", { name: /Last archive run/ })

const classificationParseCard = (page: Page) =>
  page.getByRole("region", { name: /Last classification parse run/ })

const investorTypeParseCard = (page: Page) =>
  page.getByRole("region", { name: /Last investor-type parse run/ })

// A count on the card, by its label.
const stat = (card: Locator, label: string) =>
  card
    .locator("div")
    .filter({
      has: card.page().getByRole("term").getByText(label, { exact: true }),
    })
    .getByRole("definition")

test.describe("a member", () => {
  test.use({ storageState: MEMBER.storageState })

  test("gets no Shareholding archive entry and the not-found page", async ({
    page,
  }) => {
    const response = await page.goto(SHAREHOLDING)
    expect(response?.status()).toBe(404)
    await expect(
      page.getByRole("heading", { name: "Halaman tidak ditemukan" })
    ).toBeVisible()
    await expect(
      page.getByRole("link", { name: "Shareholding archive" })
    ).toHaveCount(0)
  })
})

// Decision: serial, since every test points the one runs/latest.json of the
// Test stage's bucket at its own run.
test.describe.serial("an admin's last archive run", () => {
  test.use({ storageState: ADMIN.storageState })

  test("a complete run shows its pill, times and counts", async ({ page }) => {
    await seedLatestRun(COMPLETE)
    await page.goto(DASHBOARD)
    await page.getByRole("link", { name: "Shareholding archive" }).click()
    await expect(page).toHaveURL(SHAREHOLDING)
    await expect(page).toHaveTitle("Shareholding archive · KUMORA Terminal")
    await expect(
      page.getByRole("heading", { name: "Shareholding archive", level: 1 })
    ).toBeVisible()
    const card = lastRunCard(page)
    await expect(card).toContainText("Complete")
    await expect(card).toContainText("Started Nov 14, 20:00 WIB")
    await expect(card).toContainText("took 1 min 12 s")
    await expect(card).toContainText(COMPLETE.id)
    await expect(stat(card, "Reports added")).toHaveText("2")
    await expect(stat(card, "New versions")).toHaveText("1")
    await expect(stat(card, "Reports checked")).toHaveText("147")
    await expect(stat(card, "Not stored")).toHaveText("0")
    // A classification parse run parses, not the archive run.
    await expect(card.getByText("Months parsed")).toHaveCount(0)
    await expect(card).toContainText(
      /Production runs at 13:00 and 20:00 WIB\. Next: \w{3} \d{2}, (13|20):00 WIB\./
    )
    await expect(card.getByRole("button", { name: "Run now" })).toBeEnabled()
  })

  test("a partial run lists the URLs not stored and the other reports", async ({
    page,
  }) => {
    await seedLatestRun(PARTIAL)
    await page.goto(SHAREHOLDING)
    const card = lastRunCard(page)
    await expect(card).toContainText("Partial")
    await expect(stat(card, "Not stored")).toHaveText("1")
    await expect(card).toContainText(
      "1 report could not be stored. The next run retries it."
    )
    await expect(
      card.getByRole("list", { name: "Not stored" }).getByRole("listitem")
    ).toHaveText([NOT_STORED])
    await expect(
      card.getByRole("list", { name: "Archived under other" })
    ).toContainText(`Laporan Kepemilikan Lainnya ${OTHER}`)
  })

  test("a failed run shows its error", async ({ page }) => {
    await seedLatestRun(FAILED)
    await page.goto(SHAREHOLDING)
    const card = lastRunCard(page)
    await expect(card).toContainText("Failed")
    const alert = card.getByRole("alert")
    await expect(alert).toContainText(`Run failed: ${FAILED.error}`)
    await expect(alert).toContainText("The next run will try again.")
  })

  test("a run recorded while archive runs still parsed shows without its parse counts", async ({
    page,
  }) => {
    await seedLatestRun({
      ...PARTIAL,
      id: "cron-2026-11-12T13",
      monthsParsed: 3,
      parseFailures: [
        { date: "2026-10-30", message: "Header row 4 has no TOTAL SCRIPLESS" },
      ],
    })
    await page.goto(SHAREHOLDING)
    const card = lastRunCard(page)
    await expect(card).toContainText("cron-2026-11-12T13")
    await expect(stat(card, "Reports added")).toHaveText("1")
    await expect(card.getByText("Months parsed")).toHaveCount(0)
    await expect(
      card.getByRole("list", { name: "Parse failures" })
    ).toHaveCount(0)
  })

  test("Run now is disabled while the latest run is running", async ({
    page,
  }) => {
    // Its record says running and the Test stage holds no Workflow instance
    // for it, so it is in progress only while its start is within
    // START_WINDOW_MS (run-view.ts): it starts as it is seeded.
    await seedLatestRun(
      runAgo(0, {
        finishedAt: null,
        outcome: "running",
        reportsAdded: 0,
        newVersions: 0,
        reportsChecked: 0,
      })
    )
    await page.goto(SHAREHOLDING)
    const card = lastRunCard(page)
    await expect(card).toContainText("Running")
    await expect(card).toContainText("A run is in progress")
    await expect(card.getByRole("button", { name: "Run now" })).toBeDisabled()
  })
})

// A start time as the page writes it: Nov 13, 20:00 WIB.
const wib = (iso: string) =>
  `${new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
    hourCycle: "h23",
  }).format(new Date(iso))} WIB`

// Decision: these seed runs/ records without touching runs/latest.json, so
// they run beside the serial last-run tests above.
test.describe("an admin's archive history", () => {
  test.use({ storageState: ADMIN.storageState })

  test("the recent runs table lists the past 30 days, newest first", async ({
    page,
  }) => {
    const partial = runAgo(1 * DAY, {
      outcome: "partial",
      reportsAdded: 4,
      newVersions: 0,
      notStored: [NOT_STORED],
    })
    const complete = runAgo(2 * DAY, { reportsAdded: 3, newVersions: 2 })
    const failed = runAgo(3 * DAY, {
      outcome: "failed",
      reportsAdded: 0,
      newVersions: 0,
      error: "www.idx.id answered 403 for the shareholding report list",
    })
    const old = runAgo(40 * DAY, {})
    for (const run of [old, failed, complete, partial]) await seedRun(run)

    await page.goto(SHAREHOLDING)
    const table = page.getByRole("table", { name: "Recent runs" })
    const ours = [partial, complete, failed, old].map(({ id }) => id)
    await expect(
      table.getByRole("row").filter({ hasText: new RegExp(ours.join("|")) })
    ).toHaveText([
      `${wib(partial.startedAt)}${partial.id}Partial40`,
      `${wib(complete.startedAt)}${complete.id}Complete32`,
      `${wib(failed.startedAt)}${failed.id}Failed00`,
    ])
  })
})

// Decision: serial, and the only spec writing reports/, so the totals are
// exact before the parse runs store reports into the HoldingsDb that
// stocks.spec.ts seeds, unserialized: the classification report as Dec 2025,
// before that spec's months, and the investor-type report holding only AADI
// and TRUE, which it never opens. See apinrdw/kumora#404.
test.describe.serial("an admin's archive totals and parse runs", () => {
  test.use({ storageState: ADMIN.storageState })

  test("the archive totals count the reports per kind and the size", async ({
    page,
  }) => {
    await seedReport("above-5/2026-11-13", "a".repeat(64), 1_200)
    // A second version of a report counts too.
    await seedReport("above-5/2026-11-13", "b".repeat(64), 1_300)
    // Not an investor-type report, which the investor-type parse run below
    // would fail to parse.
    await seedReport("above-1/2026-10-31", "c".repeat(64), 2_400)

    await page.goto(SHAREHOLDING)
    const totals = page.getByRole("region", { name: "Archive totals" })
    // 4,900 bytes of files and three 77-byte records.
    await expect(totals).toContainText("3 reports · 5.1 KB")
    await expect(
      totals.getByRole("table", { name: "Reports per kind" }).getByRole("row")
    ).toHaveText([
      "Report kindKey prefixReports",
      "Holders above 5%reports/above-5/2",
      "Holders above 1%reports/above-1/1",
      "By investor typereports/investor-type/0",
      "By investor classificationreports/investor-classification/0",
      "Otherreports/other/0",
    ])
  })

  test("Parse now parses the held classification reports", async ({ page }) => {
    await seedReportFixture(
      "investor-classification",
      "classification-2026-03-31.xlsx",
      "2025-12-31"
    )

    await page.goto(SHAREHOLDING)
    const card = classificationParseCard(page)
    await expect(card).toContainText(
      "No classification parse run has happened yet."
    )
    await expect(card).toContainText(
      /Production runs at 21:00 WIB\. Next: \w{3} \d{2}, 21:00 WIB\./
    )
    await card.getByRole("button", { name: "Parse now" }).click()
    await expect(card).toContainText(/Started admin-\d+\./)

    // The run ends on its own; the page shows it once reloaded.
    await expect(async () => {
      await page.reload()
      await expect(classificationParseCard(page)).toContainText("Complete", {
        timeout: 1000,
      })
    }).toPass({ timeout: 30_000 })
    await expect(
      stat(classificationParseCard(page), "Months parsed")
    ).toHaveText("1")
    await expect(
      stat(classificationParseCard(page), "Parse failures")
    ).toHaveText("0")
    await expect(
      classificationParseCard(page).getByRole("button", { name: "Parse now" })
    ).toBeEnabled()
  })

  test("Parse now parses the held investor-type reports", async ({ page }) => {
    await seedReportFixture(
      "investor-type",
      "investor-type-2025-11-28.xlsx",
      "2025-11-28"
    )

    await page.goto(SHAREHOLDING)
    const card = investorTypeParseCard(page)
    await expect(card).toContainText(
      "No investor-type parse run has happened yet."
    )
    await expect(card).toContainText(
      /Production runs at 21:00 WIB\. Next: \w{3} \d{2}, 21:00 WIB\./
    )
    await card.getByRole("button", { name: "Parse now" }).click()
    await expect(card).toContainText(/Started admin-\d+\./)

    // The run ends on its own; the page shows it once reloaded.
    await expect(async () => {
      await page.reload()
      await expect(investorTypeParseCard(page)).toContainText("Complete", {
        timeout: 1000,
      })
    }).toPass({ timeout: 30_000 })
    await expect(stat(investorTypeParseCard(page), "Months parsed")).toHaveText(
      "1"
    )
    await expect(
      stat(investorTypeParseCard(page), "Parse failures")
    ).toHaveText("0")
    await expect(
      investorTypeParseCard(page).getByRole("button", { name: "Parse now" })
    ).toBeEnabled()
  })
})
