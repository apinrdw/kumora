import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"

import {
  KSEI_CRON,
  KSEI_PARSE_CRON,
  nextKseiParseRun,
  nextKseiRun,
} from "@/server/ksei/schedule"
import { SECTOR_CRON } from "@/server/sectors/schedule"
import {
  ARCHIVE_CRON,
  nextParseRun,
  nextScheduledRun,
  PARSE_CRON,
} from "@/server/shareholding/schedule"

// Each archive's cron handler, which a firing starts a run through.
const runKseiCron = vi.fn<(scheduledTime: number) => Promise<void>>(() =>
  Effect.runPromise(Effect.void)
)
const runKseiParseCron = vi.fn<(scheduledTime: number) => Promise<void>>(() =>
  Effect.runPromise(Effect.void)
)
const runArchiveCron = vi.fn<(scheduledTime: number) => Promise<void>>(() =>
  Effect.runPromise(Effect.void)
)
const runParseCron = vi.fn<(scheduledTime: number) => Promise<void>>(() =>
  Effect.runPromise(Effect.void)
)
const runSectorCron = vi.fn<(scheduledTime: number) => Promise<void>>(() =>
  Effect.runPromise(Effect.void)
)
vi.mock("@/server/sectors/cron", () => ({ runSectorCron }))
vi.mock("@/server/ksei/cron", () => ({ runKseiCron, runKseiParseCron }))
vi.mock("@/server/shareholding/cron", () => ({ runArchiveCron, runParseCron }))

const { runCron } = await import("@/server/crons")

const scheduledTime = Date.parse("2026-11-14T03:00:00Z")

afterEach(() => {
  vi.clearAllMocks()
})

describe("a cron firing", () => {
  it.effect("starts a KSEI archive run, and no other, on the KSEI cron", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => runCron(KSEI_CRON, scheduledTime))

      assert.deepStrictEqual(runKseiCron.mock.calls, [[scheduledTime]])
      assert.strictEqual(runKseiParseCron.mock.calls.length, 0)
      assert.strictEqual(runArchiveCron.mock.calls.length, 0)
    })
  )

  it.effect(
    "starts a KSEI parse run, and no other, on the KSEI parse cron",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runCron(KSEI_PARSE_CRON, scheduledTime))

        assert.deepStrictEqual(runKseiParseCron.mock.calls, [[scheduledTime]])
        assert.strictEqual(runKseiCron.mock.calls.length, 0)
        assert.strictEqual(runArchiveCron.mock.calls.length, 0)
      })
  )

  it.effect("fires the KSEI parse cron an hour after the KSEI archive's", () =>
    Effect.gen(function* () {
      for (const now of [
        "2026-11-14T02:30:00Z",
        "2026-11-14T03:30:00Z",
        "2026-11-14T23:59:00Z",
      ]) {
        const archive = yield* nextKseiRun(new Date(now))
        const parse = yield* nextKseiParseRun(archive)
        assert.strictEqual(parse.getTime() - archive.getTime(), 60 * 60 * 1000)
      }
    })
  )

  it.effect(
    "starts a shareholding archive run, and no KSEI one, on the IDX cron",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runCron(ARCHIVE_CRON, scheduledTime))

        assert.deepStrictEqual(runArchiveCron.mock.calls, [[scheduledTime]])
        assert.strictEqual(runParseCron.mock.calls.length, 0)
        assert.strictEqual(runKseiCron.mock.calls.length, 0)
        assert.strictEqual(runKseiParseCron.mock.calls.length, 0)
      })
  )

  it.effect(
    "starts the shareholding parse runs, and no archive run, on the parse cron",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runCron(PARSE_CRON, scheduledTime))

        assert.deepStrictEqual(runParseCron.mock.calls, [[scheduledTime]])
        assert.strictEqual(runArchiveCron.mock.calls.length, 0)
        assert.strictEqual(runKseiCron.mock.calls.length, 0)
        assert.strictEqual(runKseiParseCron.mock.calls.length, 0)
      })
  )

  it.effect("fires the parse cron an hour after the evening archive run", () =>
    Effect.gen(function* () {
      // 20:00 WIB, the evening archive run.
      const archive = yield* nextScheduledRun(new Date("2026-11-14T12:30:00Z"))
      assert.strictEqual(archive.toISOString(), "2026-11-14T13:00:00.000Z")
      const parse = yield* nextParseRun(archive)
      assert.strictEqual(parse.getTime() - archive.getTime(), 60 * 60 * 1000)
    })
  )

  it.effect(
    "starts the sector run, and no archive run, on the sector cron",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => runCron(SECTOR_CRON, scheduledTime))

        assert.deepStrictEqual(runSectorCron.mock.calls, [[scheduledTime]])
        assert.strictEqual(runArchiveCron.mock.calls.length, 0)
        assert.strictEqual(runParseCron.mock.calls.length, 0)
        assert.strictEqual(runKseiCron.mock.calls.length, 0)
      })
  )
})
