import { describe, expect, test } from "vitest"

import { LastRunCard } from "@/components/admin/shareholding/last-run-card"
import { RunId } from "@/server/archive/run"
import type { ArchiveRunResult } from "@/server/shareholding/run-result"

import { renderAt } from "../../../support/render-at.tsx"

const RUNNING: ArchiveRunResult = {
  id: RunId.make("admin-1763125032000"),
  trigger: "admin",
  startedAt: "2026-11-14T13:17:12.000Z",
  finishedAt: null,
  outcome: "running",
  reportsAdded: 0,
  newVersions: 0,
  reportsChecked: 92,
  notStored: [],
  monthsParsed: 0,
  parseFailures: [],
  other: [],
  error: null,
}

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")

describe("the last run card", () => {
  test("says how long a running run has run", async () => {
    const html = text(
      await renderAt("/", () => (
        <LastRunCard
          lastRun={{
            result: RUNNING,
            inProgress: true,
            workflowStatus: "running",
          }}
          nextRun="2026-11-15T06:00:00.000Z"
          now="2026-11-14T13:18:00.000Z"
        />
      ))
    )
    expect(html).toContain("Started Nov 14, 20:17 WIB · running for 48 s")
  })

  test("says how long a finished run took", async () => {
    const html = text(
      await renderAt("/", () => (
        <LastRunCard
          lastRun={{
            result: {
              ...RUNNING,
              outcome: "complete",
              finishedAt: "2026-11-14T13:18:24.000Z",
            },
            inProgress: false,
            workflowStatus: null,
          }}
          nextRun="2026-11-15T06:00:00.000Z"
          now="2026-11-14T14:00:00.000Z"
        />
      ))
    )
    expect(html).toContain("Started Nov 14, 20:17 WIB · took 1 min 12 s")
    expect(html).toContain("Production runs at 13:00 and 20:00 WIB.")
  })

  test("shows how many classification months a run parsed", async () => {
    const html = text(
      await renderAt("/", () => (
        <LastRunCard
          lastRun={{
            result: {
              ...RUNNING,
              outcome: "complete",
              finishedAt: "2026-11-14T13:18:24.000Z",
              monthsParsed: 8,
            },
            inProgress: false,
            workflowStatus: null,
          }}
          nextRun="2026-11-15T06:00:00.000Z"
          now="2026-11-14T14:00:00.000Z"
        />
      ))
    )
    expect(html).toContain("Months parsed 8")
  })

  test("lists the months a run couldn't parse, with why", async () => {
    const html = text(
      await renderAt("/", () => (
        <LastRunCard
          lastRun={{
            result: {
              ...RUNNING,
              outcome: "partial",
              finishedAt: "2026-11-14T13:18:24.000Z",
              monthsParsed: 3,
              parseFailures: [
                {
                  dataDate: "2026-10-30",
                  reason: "Header row 4 has no TOTAL SCRIPLESS",
                },
              ],
            },
            inProgress: false,
            workflowStatus: null,
          }}
          nextRun="2026-11-15T06:00:00.000Z"
          now="2026-11-14T14:00:00.000Z"
        />
      ))
    )
    expect(html).toContain("Parse failures 1")
    expect(html).toContain(
      "1 month could not be parsed. It keeps its earlier parsed holdings, and the next run tries again. 2026-10-30 Header row 4 has no TOTAL SCRIPLESS"
    )
  })

  test("shows what a failed run parsed below its error", async () => {
    const html = text(
      await renderAt("/", () => (
        <LastRunCard
          lastRun={{
            result: {
              ...RUNNING,
              outcome: "failed",
              finishedAt: "2026-11-14T13:18:24.000Z",
              monthsParsed: 2,
              parseFailures: [
                { dataDate: "2026-05-29", reason: "The report has no stocks" },
                { dataDate: "2026-10-30", reason: "The report has no stocks" },
              ],
              error: "IDX answered 403",
            },
            inProgress: false,
            workflowStatus: null,
          }}
          nextRun="2026-11-15T06:00:00.000Z"
          now="2026-11-14T14:00:00.000Z"
        />
      ))
    )
    expect(html).toContain("Months parsed 2")
    expect(html).toContain("Run failed: IDX answered 403")
    expect(html).toContain(
      "2 months could not be parsed. Each keeps its earlier parsed holdings"
    )
  })
})
