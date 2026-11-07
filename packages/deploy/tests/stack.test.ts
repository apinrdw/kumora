import { PLACEHOLDER_STAGE } from "alchemy/Alchemist/Operations"
import { describe, expect, test } from "vitest"

import { stageKind, stageUrl } from "@workspace/deploy"
import { stackOptions, stackStage } from "@workspace/deploy/stack"

// Alchemy evaluates a stack with PLACEHOLDER_STAGE to discover its auth
// providers (`alchemy profile edit`) and for `alchemy state`.
describe("stackOptions on alchemy's placeholder stage", () => {
  test.each(["web", "dashboard"] as const)(
    "%s lists Infisical secrets, so profile edit can offer Infisical",
    (app) => {
      const secrets = stackOptions(app).secrets({ stage: PLACEHOLDER_STAGE })
      expect(secrets).toHaveLength(2)
    }
  )

  test("still refuses a stage no branch, dev or test stage produces", () => {
    expect(() => stackOptions("web").secrets({ stage: "live_jarvis" })).toThrow(
      /Unknown stage/
    )
  })

  test("reads it as Staging", () => {
    expect(stageKind(stackStage(PLACEHOLDER_STAGE))).toBe("staging")
  })
})

describe("stageUrl", () => {
  test.each([
    ["production", "https://kumora-dashboard.kumora.workers.dev"],
    ["staging", "https://kumora-dashboard-staging.kumora.workers.dev"],
    [
      "feat-sign-in-a1b2c3",
      "https://kumora-dashboard-feat-sign-in-a1b2c3.kumora.workers.dev",
    ],
    ["dev_jarvis", "http://localhost:3001"],
    ["test", "http://localhost:3001"],
  ])("serves the dashboard on %s from %s", (stage, url) => {
    expect(stageUrl("dashboard", stackStage(stage))).toBe(url)
  })
})
