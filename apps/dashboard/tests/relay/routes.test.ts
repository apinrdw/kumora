import { describe, expect, test } from "vitest"

import { INGEST_CLOSE } from "@/relay/routes"

describe("INGEST_CLOSE", () => {
  test("gives every reason its own code", () => {
    const codes = Object.values(INGEST_CLOSE)
    expect(new Set(codes).size).toBe(codes.length)
  })

  test("keeps every code in the application range", () => {
    for (const code of Object.values(INGEST_CLOSE)) {
      expect(code).toBeGreaterThanOrEqual(4000)
      expect(code).toBeLessThanOrEqual(4999)
    }
  })
})
