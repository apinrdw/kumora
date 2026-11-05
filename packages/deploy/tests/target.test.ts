import { describe, expect, test } from "vitest"

import {
  APPS,
  deployTarget,
  devStage,
  isPreview,
  parseStage,
  stageTarget,
  type Preview,
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

describe("deployTarget", () => {
  test.each(branches)("branch %j deploys to stage %j", (branch, stage) => {
    expect(deployTarget("web", branch).stage).toBe(stage)
  })

  test.each(APPS.flatMap((app) => branches.map(([b]) => [app, b] as const)))(
    "%s from %j gets a valid stage and a Worker name of at most 54 characters",
    (app, branch) => {
      const { stage, workerName } = deployTarget(app, branch)
      expect(stage).toMatch(/^[a-z0-9][-_a-z0-9]*$/)
      expect(workerName).toMatch(/^[a-z0-9-]+$/)
      expect(workerName.length).toBeLessThanOrEqual(54)
    }
  )

  test("names the production Worker after the app alone", () => {
    expect(deployTarget("web", "main").workerName).toBe("kumora-web")
    expect(deployTarget("dashboard", "main").workerName).toBe(
      "kumora-dashboard"
    )
  })

  test("suffixes every other Worker with its stage", () => {
    expect(deployTarget("web", "staging").workerName).toBe("kumora-web-staging")
    expect(deployTarget("dashboard", "feature/login").workerName).toBe(
      "kumora-dashboard-feature-login-df7c7a"
    )
  })

  test("only production reads Infisical prod", () => {
    expect(deployTarget("web", "main").infisicalEnvironment).toBe("prod")
    expect(deployTarget("web", "staging").infisicalEnvironment).toBe("staging")
    expect(deployTarget("web", "feature/login").infisicalEnvironment).toBe(
      "staging"
    )
  })

  test.each(branches.map(([b]) => b))(
    "branch %j keeps its state in Cloudflare",
    (branch) => {
      expect(deployTarget("web", branch).stateStore).toBe("cloudflare")
    }
  )

  test.each(["Main", "main/x", "staging-2", "production", "prod", "test"])(
    "branch %j is a preview, never production or staging",
    (branch) => {
      expect(deployTarget("web", branch).stage).not.toMatch(
        /^(production|staging|test|dev_.*)$/
      )
    }
  )

  test("near-identical branches get distinct, stable stages", () => {
    const a = deployTarget("web", "fix/a").stage
    expect(deployTarget("web", "fix/a").stage).toBe(a)
    expect(deployTarget("web", "fix_a").stage).not.toBe(a)
    expect(deployTarget("web", "fix-a").stage).not.toBe(a)
  })
})

describe("stageTarget for stages that come from no branch", () => {
  test("a dev stage is local and reads Infisical staging", () => {
    expect(stageTarget("web", devStage("Jarvis"))).toEqual({
      stage: "dev_Jarvis",
      workerName: "kumora-web-dev-jarvis",
      infisicalEnvironment: "staging",
      stateStore: "local",
    })
  })

  test("the test stage is local and reads no Infisical environment", () => {
    expect(stageTarget("dashboard", parseStage("test"))).toEqual({
      stage: "test",
      workerName: "kumora-dashboard-test",
      infisicalEnvironment: undefined,
      stateStore: "local",
    })
  })
})

describe("parseStage", () => {
  test.each(["production", "staging", "test", "dev_jarvis", "fix-a-123abc"])(
    "accepts %j",
    (raw) => {
      expect(parseStage(raw)).toBe(raw)
    }
  )

  test.each(["live_jarvis", "", "Production", "fix-a", "-123abc"])(
    "refuses %j, which no branch, dev or test stage produces",
    (raw) => {
      expect(() => parseStage(raw)).toThrow(/Unknown stage/)
    }
  )

  test.each(branches.map(([b]) => b))(
    "accepts the stage of branch %j",
    (branch) => {
      const { stage } = deployTarget("web", branch)
      expect(parseStage(stage)).toBe(stage)
    }
  )
})

describe("isPreview", () => {
  test.each(["production", "staging", "test", "dev_jarvis"])(
    "refuses %j",
    (raw) => {
      expect(isPreview(parseStage(raw))).toBe(false)
    }
  )

  test("accepts a branch preview and narrows it to Preview", () => {
    const stage = deployTarget("web", "feature/login").stage
    if (!isPreview(stage)) throw new Error("expected a preview")
    const preview: Preview = stage
    expect(preview).toBe("feature-login-df7c7a")
  })

  test("a Stage is not a Preview until isPreview narrows it", () => {
    // @ts-expect-error a production Stage cannot stand where a Preview is required
    const preview: Preview = parseStage("production")
    expect(preview).toBe("production")
  })
})
