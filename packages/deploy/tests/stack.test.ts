import { assert, describe, it } from "@effect/vitest"
import * as Alchemy from "alchemy"
import { PLACEHOLDER_STAGE } from "alchemy/Alchemist/Operations"
import * as Cause from "effect/Cause"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"

import {
  DEV_PORT_VARIABLES,
  UnknownStage,
  stageKind,
  stageUrl,
} from "@workspace/deploy"
import { stackOptions, stackStage, websiteProps } from "@workspace/deploy/stack"

// The defect an Effect died with, or undefined if it did not die.
const defectOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause)
    ? Cause.squash(exit.cause)
    : undefined

// Alchemy evaluates a stack with PLACEHOLDER_STAGE to discover its auth
// providers (`alchemy profile edit`) and for `alchemy state`.
describe("stackOptions on alchemy's placeholder stage", () => {
  it.each(["web", "dashboard"] as const)(
    "%s lists Infisical secrets, so profile edit can offer Infisical",
    (app) => {
      const options = Effect.runSync(stackOptions(app))
      assert.lengthOf(options.secrets({ stage: PLACEHOLDER_STAGE }), 2)
    }
  )

  it.effect("stackStage reads it as Staging", () =>
    Effect.gen(function* () {
      const stage = yield* stackStage(PLACEHOLDER_STAGE)
      assert.strictEqual(yield* stageKind(stage), "staging")
    })
  )
})

describe("an unknown Stage inside a stack is a defect", () => {
  it("the secrets callback throws UnknownStage", () => {
    assert.throws(
      () =>
        Effect.runSync(stackOptions("web")).secrets({ stage: "live_jarvis" }),
      UnknownStage,
      /Unknown stage "live_jarvis"/
    )
  })

  it.effect("the state layer dies with UnknownStage", () =>
    Effect.gen(function* () {
      // The layer reads the Stage before it picks a store, so an unknown
      // Stage dies without reaching the other stack services.
      const { state } = yield* stackOptions("web")
      const build = Layer.build(state).pipe(
        Effect.provideService(Alchemy.Stage, "live_jarvis"),
        Effect.scoped
      ) as Effect.Effect<unknown>
      assert.instanceOf(defectOf(yield* Effect.exit(build)), UnknownStage)
    })
  )

  it.effect("websiteProps dies with UnknownStage", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(websiteProps("web", "live_jarvis"))
      assert.instanceOf(defectOf(exit), UnknownStage)
    })
  )
})

describe("websiteProps", () => {
  it.effect("names the Worker after the app and Stage", () =>
    Effect.gen(function* () {
      const props = yield* websiteProps("dashboard", "staging")
      assert.strictEqual(props.name, "kumora-dashboard-staging")
    })
  )
})

describe("stageUrl", () => {
  // Each case reads an empty environment, so a port variable the shell
  // exports cannot move the local stages off their default.
  it.effect.each([
    ["production", "https://kumora-dashboard.kumora.workers.dev/dashboard"],
    [
      "staging",
      "https://kumora-dashboard-staging.kumora.workers.dev/dashboard",
    ],
    [
      "feat-sign-in-a1b2c3",
      "https://kumora-dashboard-feat-sign-in-a1b2c3.kumora.workers.dev/dashboard",
    ],
    ["dev_jarvis", "http://localhost:3001/dashboard"],
    ["test", "http://localhost:3001/dashboard"],
  ] as const)("serves the dashboard on %s at %s", ([stage, url]) =>
    Effect.gen(function* () {
      const parsed = yield* stackStage(stage)
      assert.strictEqual<string>(yield* stageUrl("dashboard", parsed), url)
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
    )
  )

  it.effect.each([
    ["staging", "https://kumora-web-staging.kumora.workers.dev"],
    [
      "feat-sign-in-a1b2c3",
      "https://kumora-web-feat-sign-in-a1b2c3.kumora.workers.dev",
    ],
    ["test", "http://localhost:3000"],
  ] as const)("serves web on %s at its host's root, %s", ([stage, url]) =>
    Effect.gen(function* () {
      const parsed = yield* stackStage(stage)
      assert.strictEqual<string>(yield* stageUrl("web", parsed), url)
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))
    )
  )

  it.effect("serves a local stage on the port its variable names", () =>
    Effect.gen(function* () {
      const parsed = yield* stackStage("test")
      assert.strictEqual(
        yield* stageUrl("dashboard", parsed),
        "http://localhost:4123/dashboard"
      )
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            [DEV_PORT_VARIABLES.dashboard]: "4123",
          })
        )
      )
    )
  )
})
