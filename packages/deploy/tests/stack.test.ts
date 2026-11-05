import { PLACEHOLDER_STAGE } from "alchemy/Alchemist/Operations"
import { describe, expect, test } from "vitest"

import { stackOptions } from "@workspace/deploy/stack"

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
})
