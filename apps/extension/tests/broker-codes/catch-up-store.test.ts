// The extra target's Ajaib catch-up position over a chrome.storage.local
// kept in memory: another extra target starts its own.
import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { Effect, Option } from "effect"

import type { AjaibWalkPosition } from "../../src/worker/broker-codes/ajaib-walk.ts"
import {
  ajaibCatchUpStore,
  type DashboardOrigin,
} from "../../src/worker/settings.ts"

const DAY = WibDate.make("2026-11-12")
const STAGING = "https://staging.example.com" as DashboardOrigin
const PREVIEW = "https://preview.example.com" as DashboardOrigin

const memoryLocal = () => {
  const memory: Record<string, unknown> = {}
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: (key: string) =>
          Effect.runPromise(Effect.sync(() => ({ [key]: memory[key] }))),
        set: (items: Record<string, unknown>) =>
          Effect.runPromise(
            Effect.sync(() => void Object.assign(memory, items))
          ),
      },
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the Ajaib catch-up position", () => {
  it.effect("is kept per extra target's origin", () =>
    Effect.gen(function* () {
      memoryLocal()
      let origin = Option.some(STAGING)
      const store = yield* ajaibCatchUpStore(Effect.sync(() => origin))
      const done: AjaibWalkPosition = {
        day: DAY,
        pass: "done",
        page: 1,
        lastTimestamp: 0,
      }
      yield* store.load
      yield* store.save(done)
      assert.deepStrictEqual(yield* store.load, Option.some(done))

      origin = Option.some(PREVIEW)
      assert.isTrue(Option.isNone(yield* store.load))

      origin = Option.none()
      assert.isTrue(Option.isNone(yield* store.load))

      origin = Option.some(STAGING)
      assert.deepStrictEqual(yield* store.load, Option.some(done))
    })
  )

  // Codex review round 11: the save after a settings change credited the
  // old target's position to the new one.
  it.effect("credits a walk's position only to the origin it loaded for", () =>
    Effect.gen(function* () {
      memoryLocal()
      let origin = Option.some(STAGING)
      const store = yield* ajaibCatchUpStore(Effect.sync(() => origin))
      assert.isTrue(Option.isNone(yield* store.load))
      origin = Option.some(PREVIEW)
      yield* store.save({
        day: DAY,
        pass: "done",
        page: 1,
        lastTimestamp: 0,
      })
      assert.isTrue(Option.isNone(yield* store.load))
    })
  )

  // apinrdw/kumora#711: the 3-minute block walk's position, kept by an
  // earlier build, means nothing to the whole-day walk.
  it.effect("reads a position kept in the old block shape as none", () =>
    Effect.gen(function* () {
      memoryLocal()
      yield* Effect.promise(() =>
        chrome.storage.local.set({
          brokerCodesAjaibCatchUp: {
            origin: STAGING,
            value: { day: DAY, pass: "first", next: 0, repair: [] },
          },
        })
      )
      const store = yield* ajaibCatchUpStore(
        Effect.succeed(Option.some(STAGING))
      )
      assert.isTrue(Option.isNone(yield* store.load))
    })
  )
})
