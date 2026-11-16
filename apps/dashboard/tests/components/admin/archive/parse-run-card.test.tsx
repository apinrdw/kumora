import { describe, expect, test } from "vitest"

import { ParseRunCard } from "@/components/admin/archive/parse-run-card"
import { RunId } from "@/server/archive/run"
import type { ParseRunResult } from "@/server/holdings/parse-run-result"

import { renderAt } from "../../../support/render-at.tsx"

const PARTIAL: ParseRunResult = {
  id: RunId.make("cron-2026-11-14"),
  trigger: "cron",
  startedAt: "2026-11-14T14:00:00.000Z",
  finishedAt: "2026-11-14T14:00:40.000Z",
  outcome: "partial",
  monthsParsed: 3,
  parseFailures: [
    { date: "2026-05-29", message: "The report has no stocks" },
    { date: "2026-10-30", message: "Header row 4 has no TOTAL SCRIPLESS" },
  ],
  error: null,
}

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

const card = (
  lastParseRun: Parameters<typeof ParseRunCard>[0]["lastParseRun"]
) =>
  renderAt("/", () => (
    <ParseRunCard
      title="Last classification parse run"
      emptyMessage="No classification parse run has happened yet."
      lastParseRun={lastParseRun}
      parseNow={() => Promise.resolve({ id: "admin-1763125032000" })}
      times="21:00 WIB"
      nextParseRun="2026-11-15T14:00:00.000Z"
      now="2026-11-14T15:00:00.000Z"
    />
  ))

describe("a parse run card", () => {
  test("says no run has happened yet, and when the next starts", async () => {
    const html = text(await card(undefined))
    expect(html).toContain("Last classification parse run")
    expect(html).toContain("No classification parse run has happened yet.")
    expect(html).toContain(
      "Production runs at 21:00 WIB. Next: Nov 15, 21:00 WIB."
    )
  })

  test("counts the months parsed, and lists each failure with why", async () => {
    const html = text(
      await card({ result: PARTIAL, inProgress: false, workflowStatus: null })
    )
    expect(html).toContain("Partial")
    expect(html).toContain("Months parsed 3")
    expect(html).toContain("Parse failures 2")
    expect(html).toContain(
      "2 months could not be parsed. They keep their earlier parsed holdings; the next run tries again. 2026-05-29: The report has no stocks 2026-10-30: Header row 4 has no TOTAL SCRIPLESS"
    )
  })
})
