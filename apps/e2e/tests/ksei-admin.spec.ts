import type { Locator, Page } from "@playwright/test"

import { expect, test } from "../support/test"

import { ADMIN, DASHBOARD, MEMBER } from "../support/accounts"
import { wibDate } from "../support/clock"
import {
  seedKseiReport,
  seedKseiRun,
  seedLatestKseiRun,
  type SeededKseiRun,
} from "../support/ksei"

const KSEI = `${DASHBOARD}/admin/ksei`

const COMPLETE: SeededKseiRun = {
  id: "cron-2026-11-14",
  trigger: "cron",
  startedAt: "2026-11-14T03:00:00.000Z",
  finishedAt: "2026-11-14T03:01:12.000Z",
  outcome: "complete",
  reportsAdded: 2,
  newVersions: 1,
  reportsChecked: 70,
  md5Mismatches: ["BalanceposEfek20260930.zip"],
  listingFailures: [],
  notStored: [],
  error: null,
  deep: null,
}

const LISTING_ERROR =
  "KSEI's Securities holdings listing answered 405 (https://www.ksei.co.id/api/securities_ownerships?page[size]=100)"

const PARTIAL: SeededKseiRun = {
  ...COMPLETE,
  id: "admin-1763089200000",
  trigger: "admin",
  outcome: "partial",
  reportsAdded: 35,
  newVersions: 0,
  md5Mismatches: [],
  listingFailures: [{ kind: "securities-holdings", message: LISTING_ERROR }],
  notStored: ["StatisEfek20261030.txt.zip"],
}

const FAILED: SeededKseiRun = {
  ...COMPLETE,
  id: "cron-2026-11-13",
  startedAt: "2026-11-13T03:00:00.000Z",
  finishedAt: "2026-11-13T03:00:20.000Z",
  outcome: "failed",
  reportsAdded: 0,
  newVersions: 0,
  reportsChecked: 0,
  md5Mismatches: [],
  error: `KSEI's Securities statistics listing answered 405; ${LISTING_ERROR}`,
}

const DEEP: SeededKseiRun = {
  ...COMPLETE,
  id: "deep-1763089200000",
  trigger: "deep",
  startedAt: "2026-11-14T03:00:00.000Z",
  finishedAt: "2026-11-14T03:42:00.000Z",
  reportsAdded: 3,
  newVersions: 0,
  md5Mismatches: [],
  deep: {
    foundFromSeed: [
      "StatisEfek20080131.txt.zip",
      "BalanceposEfek20080131.txt.zip",
    ],
    foundByProbing: ["BalanceposEfek20080627.txt.zip"],
    monthsNotFound: {
      "securities-statistics": ["2008-05", "2008-07", "2009-03"],
      "securities-holdings": [],
    },
    probeFailures: [],
  },
}

const DAY = 86_400_000

// A run that started `ago` ms before now, named like Run now's runs.
const runAgo = (ago: number, run: Partial<SeededKseiRun>): SeededKseiRun => {
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
  page.getByRole("region", { name: /Last KSEI archive run/ })

// A count on the card, by its label.
const stat = (card: Locator, label: string) =>
  card
    .locator("div")
    .filter({
      has: card.page().getByRole("term").getByText(label, { exact: true }),
    })
    .getByRole("definition")

const NEVER = "Never looked for"

const never = (n: number) => Array.from({ length: n }, () => NEVER)

// One kind's coverage table on the page.
const coverage = (page: Page, kind: string) =>
  page
    .getByRole("region", { name: "Coverage" })
    .getByRole("table", { name: `${kind} coverage` })

// The month cells of `year` in a kind's coverage table, January first.
const months = (table: Locator, year: number) =>
  table
    .getByRole("row")
    .filter({
      has: table
        .page()
        .getByRole("rowheader", { name: String(year), exact: true }),
    })
    .getByRole("cell")

const cellsIn = (table: Locator, state: string) =>
  table.getByRole("cell", { name: state, exact: true })

test.describe("a member", () => {
  test.use({ storageState: MEMBER.storageState })

  test("gets no KSEI archive entry and the not-found page", async ({
    page,
  }) => {
    const response = await page.goto(KSEI)
    expect(response?.status()).toBe(404)
    await expect(
      page.getByRole("heading", { name: "Halaman tidak ditemukan" })
    ).toBeVisible()
    await expect(page.getByRole("link", { name: "KSEI archive" })).toHaveCount(
      0
    )
  })
})

// Decision: serial, since these tests share the Test stage's KSEI bucket.
// Each last-run test points its one runs/latest.json at its own run, the
// totals count all of reports/, and the coverage reads all of reports/ and
// the newest deep run with finds. So the totals and the coverage before any
// deep backfill come first, DEEP and the coverage's own deep run after.
test.describe.serial("an admin's KSEI archive", () => {
  test.use({ storageState: ADMIN.storageState })

  test("the totals count reports, versions and size per kind", async ({
    page,
  }) => {
    const statistics = "securities-statistics"
    await seedKseiReport(`${statistics}/2026-10-30`, "a".repeat(64), 1_200)
    // A second version of October counts as a version, not a report.
    await seedKseiReport(`${statistics}/2026-10-30`, "b".repeat(64), 1_300)
    await seedKseiReport(`${statistics}/2026-09-30`, "c".repeat(64), 1_400)

    await page.goto(KSEI)
    const totals = page.getByRole("region", { name: "Archive totals" })
    // 3,900 bytes of zips and three 77-byte records: 4,131.
    await expect(totals).toContainText("2 reports · 4.1 KB")
    await expect(
      totals.getByRole("table", { name: "Reports per kind" }).getByRole("row")
    ).toHaveText([
      "Report kindKey prefixReportsVersionsSize",
      "Securities statisticsreports/securities-statistics/234.1 KB",
      "Securities holdingsreports/securities-holdings/000 B",
    ])
  })

  test("with no deep backfill yet, every month without a KSEI report was never looked for", async ({
    page,
  }) => {
    await seedKseiReport("securities-statistics/2008-01-31", "d".repeat(64), 10)
    await seedKseiReport("securities-holdings/2008-03-31", "e".repeat(64), 10)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(KSEI)
    await expect(page.getByRole("region", { name: "Coverage" })).toContainText(
      "No Deep backfill has run yet"
    )
    const statistics = coverage(page, "Securities statistics")
    const holdings = coverage(page, "Securities holdings")
    await expect(months(statistics, 2008)).toHaveText(["Held", ...never(11)])
    await expect(months(holdings, 2008)).toHaveText([
      ...never(2),
      "Held",
      ...never(9),
    ])
    // The totals' September and October.
    await expect(months(statistics, 2026).nth(8)).toHaveText("Held")
    await expect(months(statistics, 2026).nth(9)).toHaveText("Held")
    await expect(cellsIn(statistics, "Held")).toHaveCount(3)
    await expect(cellsIn(holdings, "Held")).toHaveCount(1)
    for (const table of [statistics, holdings])
      await expect(cellsIn(table, "Not found")).toHaveCount(0)
    // From 2008 to the current month in WIB.
    const today = wibDate(Date.now())
    const thisYear = Number(today.slice(0, 4))
    await expect(statistics.getByRole("rowheader")).toHaveCount(
      thisYear - 2008 + 1
    )
    await expect(
      months(statistics, thisYear).filter({ hasText: /./ })
    ).toHaveCount(Number(today.slice(5, 7)))
    // At phone width the grid scrolls inside its card, never the page.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
  })

  test("a complete run shows its pill, times and counts", async ({ page }) => {
    await seedLatestKseiRun(COMPLETE)
    await page.goto(DASHBOARD)
    await page.getByRole("link", { name: "KSEI archive" }).click()
    await expect(page).toHaveURL(KSEI)
    await expect(page).toHaveTitle("KSEI archive · KUMORA Terminal")
    await expect(
      page.getByRole("heading", { name: "KSEI archive", level: 1 })
    ).toBeVisible()
    const card = lastRunCard(page)
    await expect(card).toContainText("Complete")
    await expect(card).toContainText("Started Nov 14, 10:00 WIB")
    await expect(card).toContainText("took 1 min 12 s")
    await expect(card).toContainText(COMPLETE.id)
    await expect(stat(card, "Reports added")).toHaveText("2")
    await expect(stat(card, "New versions")).toHaveText("1")
    await expect(stat(card, "Reports checked")).toHaveText("70")
    await expect(stat(card, "Not stored")).toHaveText("0")
    await expect(stat(card, "MD5 mismatches")).toHaveText("1")
    await expect(
      card.getByRole("list", { name: "MD5 mismatches" }).getByRole("listitem")
    ).toHaveText(["BalanceposEfek20260930.zip"])
    await expect(card).toContainText(
      /Production runs at 10:00 WIB\. Next: \w{3} \d{2}, 10:00 WIB\./
    )
    await expect(card.getByRole("button", { name: "Run now" })).toBeEnabled()
    await expect(card).not.toContainText("Deep backfill:")
  })

  test("Deep backfill asks before it starts", async ({ page }) => {
    await seedLatestKseiRun(COMPLETE)
    await page.goto(KSEI)
    await lastRunCard(page)
      .getByRole("button", { name: "Deep backfill" })
      .click()
    const dialog = page.getByRole("dialog", { name: "Start a deep backfill?" })
    await expect(dialog).toContainText("Probes about 2,000 URLs on ksei.co.id.")
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden()
    await expect(lastRunCard(page)).not.toContainText("Started deep-")
  })

  test("a deep run shows what it found and the months not found", async ({
    page,
  }) => {
    await seedLatestKseiRun(DEEP)
    await page.goto(KSEI)
    const card = lastRunCard(page)
    await expect(
      page.getByRole("region", { name: /Last KSEI archive run.*Deep backfill/ })
    ).toBeVisible()
    const summary = card.getByText(
      "Deep backfill: 2 reports from the seed, 1 report by probing, 3 months not found."
    )
    await expect(
      card.getByRole("list", { name: "Found from the seed" })
    ).toBeHidden()
    await summary.click()
    await expect(
      card
        .getByRole("list", { name: "Found from the seed" })
        .getByRole("listitem")
    ).toHaveText([
      "StatisEfek20080131.txt.zip",
      "BalanceposEfek20080131.txt.zip",
    ])
    await expect(
      card.getByRole("list", { name: "Found by probing" }).getByRole("listitem")
    ).toHaveText(["BalanceposEfek20080627.txt.zip"])
    await expect(
      card
        .getByRole("list", { name: "Securities statistics months not found" })
        .getByRole("listitem")
    ).toHaveText(["2008: 05, 07", "2009: 03"])
    await expect(card).toContainText("Securities holdings: 0 months not found.")
  })

  test("a partial run names the listing it couldn't read and the files not stored", async ({
    page,
  }) => {
    await seedLatestKseiRun(PARTIAL)
    await page.goto(KSEI)
    const card = lastRunCard(page)
    await expect(card).toContainText("Partial")
    await expect(stat(card, "Not stored")).toHaveText("1")
    await expect(
      card.getByRole("list", { name: "Listings not read" })
    ).toHaveText(`Securities holdings: ${LISTING_ERROR}`)
    await expect(card).toContainText(
      "1 report could not be stored. The next run retries it."
    )
    await expect(
      card.getByRole("list", { name: "Not stored" }).getByRole("listitem")
    ).toHaveText(["StatisEfek20261030.txt.zip"])
  })

  test("a failed run shows its error", async ({ page }) => {
    await seedLatestKseiRun(FAILED)
    await page.goto(KSEI)
    const alert = lastRunCard(page).getByRole("alert")
    await expect(lastRunCard(page)).toContainText("Failed")
    await expect(alert).toContainText(`Run failed: ${FAILED.error}`)
  })

  test("Run now is disabled while the latest run is running", async ({
    page,
  }) => {
    // In progress only while its start is within START_WINDOW_MS: the Test
    // stage holds no Workflow instance for it.
    await seedLatestKseiRun(
      runAgo(0, {
        finishedAt: null,
        outcome: "running",
        reportsAdded: 0,
        newVersions: 0,
        reportsChecked: 0,
        md5Mismatches: [],
      })
    )
    await page.goto(KSEI)
    const card = lastRunCard(page)
    await expect(card).toContainText("Running")
    await expect(card).toContainText("A run is in progress")
    await expect(card.getByRole("button", { name: "Run now" })).toBeDisabled()
    await expect(
      card.getByRole("button", { name: "Deep backfill" })
    ).toBeDisabled()
  })

  test("the coverage shows held, not found and never looked for per kind", async ({
    page,
  }) => {
    // Newer than DEEP, so the coverage reads this run's months not found.
    const started = Math.floor(Date.now() / 1000) * 1000
    const id = `deep-${started}`
    await seedKseiRun({
      ...DEEP,
      id,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(started + 60_000).toISOString(),
      deep: {
        foundFromSeed: [],
        foundByProbing: [],
        monthsNotFound: {
          "securities-statistics": ["2008-02", "2008-03"],
          "securities-holdings": ["2008-01", "2009-12"],
        },
        // Its months are neither found nor not found.
        probeFailures: [
          { kind: "securities-holdings", year: 2010, message: "timed out" },
        ],
      },
    })

    await page.goto(KSEI)
    await expect(page.getByRole("region", { name: "Coverage" })).toContainText(
      `Not found by the latest Deep backfill, ${id}, finished`
    )
    const statistics = coverage(page, "Securities statistics")
    const holdings = coverage(page, "Securities holdings")
    await expect(months(statistics, 2008)).toHaveText([
      "Held",
      "Not found",
      "Not found",
      ...never(9),
    ])
    await expect(months(holdings, 2008)).toHaveText([
      "Not found",
      NEVER,
      "Held",
      ...never(9),
    ])
    await expect(months(holdings, 2009)).toHaveText([...never(11), "Not found"])
    await expect(months(holdings, 2010)).toHaveText(never(12))
    await expect(cellsIn(statistics, "Not found")).toHaveCount(2)
    await expect(cellsIn(holdings, "Not found")).toHaveCount(2)
    await expect(cellsIn(statistics, "Held")).toHaveCount(3)
    await expect(cellsIn(holdings, "Held")).toHaveCount(1)
  })
})

// Decision: these seed runs/ records without touching runs/latest.json, and
// no deep finds, so they run beside the serial tests above.
test.describe("an admin's KSEI archive history", () => {
  test.use({ storageState: ADMIN.storageState })

  test("the recent runs table lists the past 30 days", async ({ page }) => {
    const partial = runAgo(1 * DAY, {
      outcome: "partial",
      reportsAdded: 4,
      newVersions: 0,
    })
    const complete = runAgo(2 * DAY, { reportsAdded: 3, newVersions: 2 })
    const old = runAgo(40 * DAY, {})
    const started = Math.floor((Date.now() - 3 * DAY) / 1000) * 1000
    // Its plan failed, so it has no finds for the coverage to read.
    const deep = runAgo(3 * DAY, {
      id: `deep-${started}`,
      trigger: "deep",
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(started + 60_000).toISOString(),
      outcome: "failed",
      error: "Neither KSEI listing could be read.",
    })
    for (const run of [old, complete, partial, deep]) await seedKseiRun(run)

    await page.goto(KSEI)
    const table = page.getByRole("table", { name: "Recent runs" })
    const ours = [partial, complete, old].map(({ id }) => id)
    await expect(
      table.getByRole("row").filter({ hasText: new RegExp(ours.join("|")) })
    ).toHaveCount(2)
    await expect(table).toContainText(partial.id)
    await expect(table).toContainText(complete.id)
    await expect(
      table.getByRole("row").filter({ hasText: deep.id })
    ).toContainText("Deep backfill")
    await expect(
      table.getByRole("row").filter({ hasText: complete.id })
    ).not.toContainText("Deep backfill")
  })
})
