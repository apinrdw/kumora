import { assert, describe, it } from "@effect/vitest"
import { Command } from "effect/cli"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import { deployCommand } from "../src/deploy-command.ts"
import { cliTestLayer, fakeStacks } from "./support.ts"

const complete = {
  WORKERS_CI_BRANCH: "feature/login",
  INFISICAL_CLIENT_ID: "client-id",
  INFISICAL_CLIENT_SECRET: "client-secret",
}

const deploy = (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  stacks = fakeStacks()
) =>
  Command.runWith(deployCommand, { version: "test" })(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        cliTestLayer,
        stacks.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown(env))
      )
    )
  )

describe("deploy", () => {
  it.effect.each(Object.keys(complete))(
    "fails with ConfigError when %s is missing, deploying nothing",
    (name) =>
      Effect.gen(function* () {
        const stacks = fakeStacks()
        const { [name as keyof typeof complete]: _, ...env } = complete
        const error = yield* Effect.flip(deploy(["web"], env, stacks))
        assert.strictEqual(error._tag, "ConfigError")
        assert.include(error.message, name)
        assert.deepStrictEqual(stacks.deployed, [])
      })
  )

  it.effect("treats an empty variable as missing", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks()
      const env = { ...complete, INFISICAL_CLIENT_SECRET: "" }
      const error = yield* Effect.flip(deploy(["web"], env, stacks))
      assert.strictEqual(error._tag, "ConfigError")
      assert.deepStrictEqual(stacks.deployed, [])
    })
  )

  it.effect("rejects an app that isn't web or dashboard", () =>
    Effect.gen(function* () {
      const stacks = fakeStacks()
      const error = yield* Effect.flip(deploy(["api"], complete, stacks))
      assert.strictEqual(error._tag, "ShowHelp")
      assert.deepStrictEqual(stacks.deployed, [])
    })
  )
})
