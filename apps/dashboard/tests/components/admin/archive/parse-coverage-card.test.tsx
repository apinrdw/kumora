import { describe, expect, test } from "vitest"

import { ParseCoverageCard } from "@/components/admin/archive/parse-coverage-card"

import { renderAt } from "../../../support/render-at.tsx"

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

const card = (
  coverage: Parameters<typeof ParseCoverageCard>[0]["grids"][number]["coverage"]
) =>
  renderAt("/", () => (
    <ParseCoverageCard grids={[{ title: "Securities holdings", coverage }]} />
  ))

describe("a parse coverage card", () => {
  test("says no report is archived yet before any month", async () => {
    const html = text(await card([]))
    expect(html).toContain("Parse coverage")
    expect(html).toContain("No Securities holdings report is archived yet.")
  })

  test("marks each archived month's state and leaves the rest blank", async () => {
    const html = await card([
      {
        year: 2025,
        months: [
          ...Array.from({ length: 11 }, () => null),
          { date: "2025-12-31", state: "parsed" },
        ],
      },
      {
        year: 2026,
        months: [
          { date: "2026-01-30", state: "stale" },
          { date: "2026-02-27", state: "failed" },
          { date: "2026-03-31", state: "not-parsed" },
          ...Array.from({ length: 9 }, () => null),
        ],
      },
    ])
    expect(html).toContain('aria-label="Securities holdings parse coverage"')
    expect(text(html)).toContain(
      "Parsed Stale Failed Not parsed yet Securities holdings"
    )
    expect(html).toContain('title="December 2025: Parsed (2025-12-31)"')
    expect(html).toContain('title="January 2026: Stale (2026-01-30)"')
    expect(html).toContain('title="February 2026: Failed (2026-02-27)"')
    expect(html).toContain('title="March 2026: Not parsed yet (2026-03-31)"')
    // Each year's row: its year, then a label for each archived month only.
    expect(text(html)).toContain("2025 Parsed 2026 Stale Failed Not parsed yet")
    expect(html.match(/title="/g)).toHaveLength(4)
  })
})
