import { assert, describe, it } from "@effect/vitest"
import * as Alchemy from "alchemy"
import { PLACEHOLDER_STAGE } from "alchemy/Alchemist/Operations"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"

import { UnknownStage } from "@workspace/deploy"
import { stackOptions, websiteProps } from "@workspace/deploy/stack"

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
      const secrets = stackOptions(app).secrets({ stage: PLACEHOLDER_STAGE })
      assert.lengthOf(secrets, 2)
    }
  )
})

describe("an unknown Stage inside a stack is a defect", () => {
  it("the secrets callback throws UnknownStage", () => {
    assert.throws(
      () => stackOptions("web").secrets({ stage: "live_jarvis" }),
      UnknownStage,
      /Unknown stage "live_jarvis"/
    )
  })

  it.effect("the state layer dies with UnknownStage", () =>
    Effect.gen(function* () {
      // The layer reads the Stage before it picks a store, so an unknown
      // Stage dies without reaching the other stack services.
      const build = Layer.build(stackOptions("web").state).pipe(
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
