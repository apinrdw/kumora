import { assert, describe, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"

import {
  APPS,
  deployTarget,
  devStage,
  parseStage,
  Preview,
  stageTarget,
} from "@workspace/deploy"

// Hashes are SHA-256 prefixes computed outside this code (Python hashlib).
const branches = [
  ["main", "production"],
  ["staging", "staging"],
  ["feature/login", "feature-login-df7c7a"],
  ["feature/login2", "feature-login2-71ffdb"],
  ["Feat/Ünïcode-ブランチ", "feat--n-code-b0c8e7"],
  ["x".repeat(200), `${"x".repeat(30)}-aa20c2`],
  ["/leading", "leading-eee76a"],
  ["ブランチ", "ccf328"],
] as const

const stageOf = (branch: string) =>
  Effect.map(deployTarget("web", branch), (target) => target.stage)

describe("deployTarget", () => {
  it.effect.each(branches)(
    "branch %j deploys to its stage",
    ([branch, stage]) =>
      Effect.gen(function* () {
        assert.strictEqual<string>(yield* stageOf(branch), stage)
      })
  )

  it.effect.each(
    APPS.flatMap((app) => branches.map(([b]) => [app, b] as const))
  )(
    "%s from %j gets a valid stage and a Worker name of at most 54 characters",
    ([app, branch]) =>
      Effect.gen(function* () {
        const { stage, workerName } = yield* deployTarget(app, branch)
        assert.match(stage, /^[a-z0-9][-_a-z0-9]*$/)
        assert.match(workerName, /^[a-z0-9-]+$/)
        assert.isAtMost(workerName.length, 54)
      })
  )

  it.effect("names the production Worker after the app alone", () =>
    Effect.gen(function* () {
      const web = yield* deployTarget("web", "main")
      const dashboard = yield* deployTarget("dashboard", "main")
      assert.strictEqual(web.workerName, "kumora-web")
      assert.strictEqual(dashboard.workerName, "kumora-dashboard")
    })
  )

  it.effect("suffixes every other Worker with its stage", () =>
    Effect.gen(function* () {
      const staging = yield* deployTarget("web", "staging")
      const preview = yield* deployTarget("dashboard", "feature/login")
      assert.strictEqual(staging.workerName, "kumora-web-staging")
      assert.strictEqual(
        preview.workerName,
        "kumora-dashboard-feature-login-df7c7a"
      )
    })
  )

  it.effect("only production reads Infisical prod", () =>
    Effect.gen(function* () {
      const environmentOf = (branch: string) =>
        Effect.map(
          deployTarget("web", branch),
          (target) => target.infisicalEnvironment
        )
      assert.strictEqual(yield* environmentOf("main"), "prod")
      assert.strictEqual(yield* environmentOf("staging"), "staging")
      assert.strictEqual(yield* environmentOf("feature/login"), "staging")
    })
  )

  it.effect.each(branches.map(([b]) => b))(
    "branch %j keeps its state in Cloudflare",
    (branch) =>
      Effect.gen(function* () {
        const { stateStore } = yield* deployTarget("web", branch)
        assert.strictEqual(stateStore, "cloudflare")
      })
  )

  it.effect.each(["Main", "main/x", "staging-2", "production", "prod", "test"])(
    "branch %j is a preview, never production or staging",
    (branch) =>
      Effect.gen(function* () {
        assert.notMatch(
          yield* stageOf(branch),
          /^(production|staging|test|dev_.*)$/
        )
      })
  )

  it.effect("near-identical branches get distinct, stable stages", () =>
    Effect.gen(function* () {
      const a = yield* stageOf("fix/a")
      assert.strictEqual(yield* stageOf("fix/a"), a)
      assert.notStrictEqual(yield* stageOf("fix_a"), a)
      assert.notStrictEqual(yield* stageOf("fix-a"), a)
    })
  )
})

describe("stageTarget for stages that come from no branch", () => {
  it.effect("a dev stage is local and reads Infisical staging", () =>
    Effect.gen(function* () {
      const target = yield* stageTarget("web", yield* devStage("Jarvis"))
      assert.deepStrictEqual<object>(target, {
        stage: "dev_Jarvis",
        workerName: "kumora-web-dev-jarvis",
        infisicalEnvironment: "staging",
        stateStore: "local",
      })
    })
  )

  it.effect("the test stage is local and reads no Infisical environment", () =>
    Effect.gen(function* () {
      const target = yield* stageTarget("dashboard", yield* parseStage("test"))
      assert.deepStrictEqual<object>(target, {
        stage: "test",
        workerName: "kumora-dashboard-test",
        infisicalEnvironment: undefined,
        stateStore: "local",
      })
    })
  )
})

describe("parseStage", () => {
  it.effect.each([
    "production",
    "staging",
    "test",
    "dev_jarvis",
    "fix-a-123abc",
  ])("accepts %j", (raw) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* parseStage(raw), raw)
    })
  )

  it.effect.each(["live_jarvis", "", "Production", "fix-a", "-123abc"])(
    "refuses %j with UnknownStage, since no branch, dev or test stage produces it",
    (raw) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(parseStage(raw))
        assert.strictEqual(error._tag, "UnknownStage")
        assert.strictEqual(error.stage, raw)
        assert.match(error.message, /^Unknown stage "/)
      })
  )

  it.effect.each(branches.map(([b]) => b))(
    "accepts the stage of branch %j",
    (branch) =>
      Effect.gen(function* () {
        const stage = yield* stageOf(branch)
        assert.strictEqual(yield* parseStage(stage), stage)
      })
  )
})

describe("Preview", () => {
  it.effect.each(["production", "staging", "test", "dev_jarvis"])(
    "refuses %j",
    (raw) =>
      Effect.gen(function* () {
        const stage = yield* parseStage(raw)
        const decoded = yield* Effect.result(
          Schema.decodeEffect(Preview)(stage)
        )
        assert.isTrue(Result.isFailure(decoded))
      })
  )

  it.effect("accepts a branch preview as a Preview", () =>
    Effect.gen(function* () {
      const stage = yield* stageOf("feature/login")
      const preview: Preview = yield* Schema.decodeEffect(Preview)(stage)
      assert.strictEqual(preview, "feature-login-df7c7a")
    })
  )

  it.effect("a Stage is not a Preview until isPreview narrows it", () =>
    Effect.gen(function* () {
      // @ts-expect-error a production Stage cannot stand where a Preview is required
      const preview: Preview = yield* parseStage("production")
      assert.strictEqual(preview, "production")
    })
  )
})
