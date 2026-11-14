import { describe, expect, test } from "vitest"

import { LastRunCard } from "@/components/admin/shareholding/last-run-card"
import { ArchiveRunId } from "@/server/archive/run"
import type { ArchiveRunResult } from "@/server/shareholding/run-result"

import { renderAt } from "../../../support/render-at.tsx"

const RUNNING: ArchiveRunResult = {
  id: ArchiveRunId.make("admin-1763125032000"),
  trigger: "admin",
  startedAt: "2026-11-14T13:17:12.000Z",
  finishedAt: null,
  outcome: "running",
  reportsAdded: 0,
  newVersions: 0,
  reportsChecked: 92,
  notStored: [],
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
})
