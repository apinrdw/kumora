import { assert, describe, it } from "@effect/vitest"
import { WibDate } from "@workspace/relay"
import { Effect, Option } from "effect"

import type { AjaibLock } from "../src/worker/ajaib-lock.ts"
import { badgeOf } from "../src/worker/badge.ts"
import type { BrokerCodesProgress } from "../src/worker/broker-codes/run-queue.ts"
import type { TargetStates } from "../src/worker/settings.ts"

const CONNECTED: TargetStates = { production: "connected", extra: "off" }
const UNLOCKED: AjaibLock = { state: "unlocked" }
const IDLE: BrokerCodesProgress = { state: "idle" }
const SIGNED_OUT: BrokerCodesProgress = {
  state: "paused",
  cause: "signed-out",
}
const NO_PIN: AjaibLock = { state: "locked", reason: "no-pin" }

const badge = (
  states: TargetStates,
  lock: AjaibLock = UNLOCKED,
  progress: BrokerCodesProgress = IDLE
) =>
  badgeOf({
    states: Option.some(states),
    lock: Option.some(lock),
    progress: Option.some(progress),
  })

describe("the toolbar badge", () => {
  it.effect("shows the worst target state over a broker codes pause", () =>
    Effect.gen(function* () {
      const shown = yield* badge(
        { production: "rejected-token", extra: "retrying" },
        NO_PIN,
        SIGNED_OUT
      )
      assert.strictEqual(shown.text, "KEY")
      assert.include(shown.title, "production: ingest token rejected")
      assert.strictEqual(
        (yield* badge({ production: "retrying", extra: "off" }, NO_PIN)).text,
        "…"
      )
    })
  )

  it.effect(
    "shows PIN for a locked Ajaib tab, then OUT for a signed-out Stockbit tab",
    () =>
      Effect.gen(function* () {
        const pin = yield* badge(
          CONNECTED,
          { state: "locked", reason: "refused" },
          SIGNED_OUT
        )
        assert.strictEqual(pin.text, "PIN")
        assert.include(pin.title, "Ajaib locked: the PIN was refused")
        const out = yield* badge(CONNECTED, UNLOCKED, SIGNED_OUT)
        assert.strictEqual(out.text, "OUT")
        assert.include(out.title, "Stockbit signed out")
      })
  )

  it.effect(
    "shows nothing for progress, market hours, an owner pause or the lock being typed",
    () =>
      Effect.gen(function* () {
        const quiet: ReadonlyArray<[AjaibLock, BrokerCodesProgress]> = [
          [
            UNLOCKED,
            {
              state: "walking",
              walk: "newest",
              day: WibDate.make("2026-11-12"),
              feed: "Stockbit",
              trades: { fetched: 10, of: 100, perSecond: 300 },
            },
          ],
          [UNLOCKED, { state: "paused", cause: "market-hours" }],
          [UNLOCKED, { state: "paused", cause: "paused" }],
          [UNLOCKED, { state: "paused", cause: "no-tab" }],
          [{ state: "unlocking" }, IDLE],
        ]
        for (const [lock, progress] of quiet)
          assert.strictEqual((yield* badge(CONNECTED, lock, progress)).text, "")
      })
  )

  it.effect("reads nothing stored as no badge", () =>
    Effect.gen(function* () {
      const shown = yield* badgeOf({
        states: Option.none(),
        lock: Option.none(),
        progress: Option.none(),
      })
      assert.strictEqual(shown.text, "")
    })
  )
})
