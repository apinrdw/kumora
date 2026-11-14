import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Logger } from "effect"

import { makeErrorLog, type ErrorLogEntry } from "../src/worker/error-log.ts"

// A store that starts with `kept`, and every ring it was saved with.
const memoryStore = (kept: ReadonlyArray<ErrorLogEntry> = []) => {
  const saved: Array<ReadonlyArray<ErrorLogEntry>> = []
  return {
    saved,
    store: {
      load: Effect.succeed(kept),
      save: (entries: ReadonlyArray<ErrorLogEntry>) =>
        Effect.sync(() => {
          saved.push(entries)
        }),
    },
  }
}

const logThrough = (
  store: ReturnType<typeof memoryStore>["store"],
  logs: Effect.Effect<void>
) =>
  Effect.scoped(
    Effect.flatMap(makeErrorLog(store), (logger) =>
      Effect.provide(logs, Logger.layer([logger]))
    )
  )

describe("the error log", () => {
  it.effect("keeps the newest 50 Error and Fatal entries, nothing lower", () =>
    Effect.gen(function* () {
      const { saved, store } = memoryStore()
      yield* logThrough(
        store,
        Effect.gen(function* () {
          for (let at = 1; at <= 59; at++) yield* Effect.logError(`error ${at}`)
          yield* Effect.logWarning("a warning")
          yield* Effect.logInfo("an info line")
          yield* Effect.logFatal("Relay stopped", Cause.die(new Error("boom")))
        })
      )
      const ring = saved.at(-1) ?? []
      assert.lengthOf(ring, 50)
      assert.deepStrictEqual(
        ring.map(({ level, message }) => `${level} ${message}`),
        [
          ...Array.from({ length: 49 }, (_, at) => `Error error ${at + 11}`),
          "Fatal Relay stopped",
        ]
      )
      assert.isUndefined(ring[0]?.cause)
      assert.include(ring.at(-1)?.cause, "boom")
    })
  )

  it.effect("keeps the entries stored before the worker restarted", () =>
    Effect.gen(function* () {
      const before = Array.from({ length: 48 }, (_, at): ErrorLogEntry => ({
        at,
        level: "Error",
        message: `before ${at}`,
      }))
      const { saved, store } = memoryStore(before)
      yield* logThrough(
        store,
        Effect.gen(function* () {
          yield* Effect.logError("after 1")
          yield* Effect.logError("after 2")
          yield* Effect.logError("after 3")
        })
      )
      const messages = (saved.at(-1) ?? []).map(({ message }) => message)
      assert.lengthOf(messages, 50)
      assert.strictEqual(messages[0], "before 1")
      assert.deepStrictEqual(messages.slice(-3), [
        "after 1",
        "after 2",
        "after 3",
      ])
    })
  )
})
