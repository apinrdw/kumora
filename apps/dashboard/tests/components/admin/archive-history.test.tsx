import { describe, expect, test } from "vitest"

import {
  ArchiveTotalsCard,
  RecentRunsCard,
} from "@/components/admin/archive-history"
import type { ArchiveTotals } from "@/server/shareholding/history"
import { ArchiveRunId } from "@/server/shareholding/run-result"

import { renderAt } from "../../support/render-at.tsx"

const NO_REPORTS: ArchiveTotals = {
  kinds: [
    { kind: "above-5", reports: 0 },
    { kind: "above-1", reports: 0 },
    { kind: "investor-type", reports: 0 },
    { kind: "investor-classification", reports: 0 },
    { kind: "other", reports: 0 },
  ],
  reports: 0,
  bytes: 0,
}

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("the recent runs", () => {
  test("say no run happened in the past 30 days before any run", async () => {
    const html = text(await renderAt("/", () => <RecentRunsCard runs={[]} />))
    expect(html).toContain("Recent runs")
    expect(html).toContain("No archive run in the past 30 days.")
  })

  test("list each run's start in WIB, id, outcome and counts", async () => {
    const html = text(
      await renderAt("/", () => (
        <RecentRunsCard
          runs={[
            {
              id: ArchiveRunId.make("cron-2026-11-13T06"),
              trigger: "cron",
              startedAt: "2026-11-13T06:00:00.000Z",
              finishedAt: "2026-11-13T06:00:34.000Z",
              outcome: "partial",
              reportsAdded: 3,
              newVersions: 2,
              reportsChecked: 147,
              notStored: ["https://www.idx.co.id/Media/a.xlsx"],
              other: [],
              error: null,
            },
          ]}
        />
      ))
    )
    expect(html).toContain("Nov 13, 13:00 WIB cron-2026-11-13T06 Partial 3 2")
  })
})

describe("the archive totals", () => {
  test("say nothing is archived yet before any report", async () => {
    const html = await renderAt("/", () => (
      <ArchiveTotalsCard totals={NO_REPORTS} />
    ))
    expect(text(html)).toContain("No shareholding report is archived yet.")
    expect(html).not.toContain("<table")
  })

  test("show the reports per kind, the total and the size", async () => {
    const html = text(
      await renderAt("/", () => (
        <ArchiveTotalsCard
          totals={{
            kinds: [
              { kind: "above-5", reports: 128 },
              { kind: "above-1", reports: 6 },
              { kind: "investor-type", reports: 6 },
              { kind: "investor-classification", reports: 6 },
              { kind: "other", reports: 1 },
            ],
            reports: 147,
            bytes: 56_900_000,
          }}
        />
      ))
    )
    expect(html).toContain("147 reports · 56.9 MB")
    expect(html).toContain("Holders above 5% reports/above-5/ 128")
    expect(html).toContain("Other reports/other/ 1")
  })
})
