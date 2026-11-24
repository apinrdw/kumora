import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { RunId } from "@/server/archive/run"
import { recentRunsStatement } from "@/server/archive/run-rows"

import { memoryArchiveDb } from "./memory-archive-db.ts"
import { SHAREHOLDING_ARCHIVE, seedRun } from "./runs.ts"

describe("the recent runs read", () => {
  it.effect(
    "cuts each record to its fields with their JSON types, a boolean or a nested value included",
    () => {
      const db = memoryArchiveDb()
      const record = {
        id: RunId.make("cron-2026-11-14T13"),
        trigger: "cron",
        startedAt: "2026-11-14T13:00:00.000Z",
        finishedAt: null,
        outcome: "complete" as const,
        error: null,
        reportsAdded: 2,
        partial: true,
        counts: { stored: [1, 2], skipped: { reason: "held" } },
        notStored: ["https://example.com/a.xlsx"],
      }
      seedRun(db, SHAREHOLDING_ARCHIVE, record)
      return Effect.gen(function* () {
        const { rows } = yield* db.batch([
          recentRunsStatement(
            SHAREHOLDING_ARCHIVE,
            ["id", "outcome", "reportsAdded", "partial", "counts", "error"],
            0
          ),
        ])
        assert.deepStrictEqual(
          rows[0]?.map((row) => JSON.parse(String(row["record"]))),
          [
            {
              id: record.id,
              outcome: record.outcome,
              reportsAdded: 2,
              partial: true,
              counts: record.counts,
              error: null,
            },
          ]
        )
      })
    }
  )
})
