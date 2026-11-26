import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import { StageUrl } from "@workspace/deploy/stage-url"
import { Cause, Effect, Logger, Option } from "effect"

import { REDACTED, makeErrorLog } from "../src/worker/error-log.ts"
import {
  AjaibPin,
  errorLogStore,
  loadRelayStopped,
  saveRelayStopped,
  saveSettings,
  savePin,
  sessionPinStore,
} from "../src/worker/settings.ts"
import { memorySession } from "./memory-session.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

const PIN = "482913"
const ACCESS_TOKEN = "ajaib-access-7f3c9e"
const PRODUCTION_TOKEN = "production-ingest-91ab"
const EXTRA_TOKEN = "extra-ingest-5d2e"
// A JWT the worker never stores, as Stockbit's cookie token is.
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpcy1pcy1hLXNpZ25hdHVyZQ"
const SECRETS = [PIN, ACCESS_TOKEN, PRODUCTION_TOKEN, EXTRA_TOKEN, JWT]

// A defect whose message holds every credential the worker knows.
const leaky = () => Cause.die(new Error(`request failed: ${SECRETS.join(" ")}`))

const storeCredentials = Effect.gen(function* () {
  memorySession()
  yield* savePin(AjaibPin.make(PIN))
  const entry = yield* sessionPinStore.latest
  assert.isTrue(Option.isSome(entry))
  if (Option.isSome(entry))
    yield* entry.value.setSignIn({
      state: "signed-in",
      accessToken: ACCESS_TOKEN,
    })
  yield* saveSettings({
    productionToken: PRODUCTION_TOKEN,
    extra: {
      url: StageUrl.make("https://staging.example"),
      token: EXTRA_TOKEN,
    },
  })
})

const logThroughStore = (logs: Effect.Effect<void>) =>
  Effect.scoped(
    Effect.flatMap(makeErrorLog(errorLogStore), (logger) =>
      Effect.provide(logs, Logger.layer([logger]))
    )
  )

const assertHidden = (text: string) => {
  for (const secret of SECRETS) assert.notInclude(text, secret)
  assert.include(text, "request failed")
}

describe("a stored cause", () => {
  it.effect("hides credentials in the error log's entries", () =>
    Effect.gen(function* () {
      yield* storeCredentials
      yield* logThroughStore(Effect.logError(`failed with ${PIN}`, leaky()))
      const [entry] = yield* errorLogStore.load
      assert.isDefined(entry)
      assertHidden(`${entry?.message} ${entry?.cause}`)
      assert.include(entry?.cause, REDACTED)
    })
  )

  it.effect("hides credentials in the Relay stopped record", () =>
    Effect.gen(function* () {
      yield* storeCredentials
      yield* saveRelayStopped({ at: 1, cause: Cause.pretty(leaky()) })
      const stopped = yield* loadRelayStopped
      assert.isTrue(Option.isSome(stopped))
      if (Option.isSome(stopped)) assertHidden(stopped.value.cause)
    })
  )

  it.effect("hides a PIN wiped before its line was saved", () =>
    Effect.gen(function* () {
      memorySession()
      const wiped = "615204"
      yield* savePin(AjaibPin.make(wiped))
      // The check reads the PIN, is refused and wipes it; the line it logged
      // waits for the error log's next save.
      const entry = yield* sessionPinStore.latest
      assert.isTrue(Option.isSome(entry))
      if (Option.isSome(entry)) yield* entry.value.wipePin
      yield* logThroughStore(
        Effect.logError("PIN check failed", Cause.die(new Error(wiped)))
      )
      const [stored] = yield* errorLogStore.load
      assert.isDefined(stored)
      assert.notInclude(stored?.cause, wiped)
    })
  )
})
