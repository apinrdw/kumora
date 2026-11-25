import { assert, describe, it } from "@effect/vitest"

import { manifest } from "../manifest.ts"

describe("the manifest's host permissions", () => {
  it("name Production's dashboard by its origin, though it has a path", () => {
    const hosts =
      manifest("https://kumora.pusat.ai/dashboard").host_permissions ?? []
    assert.include(hosts, "https://kumora.pusat.ai/*")
    assert.notInclude(hosts, "https://kumora.pusat.ai/dashboard/*")
  })
})
