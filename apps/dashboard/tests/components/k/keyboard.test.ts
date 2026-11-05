import { describe, expect, test } from "vitest"

import { isActivationKey } from "@/components/k/keyboard"

describe("isActivationKey", () => {
  test("Enter and Space activate, like a native button", () => {
    expect(isActivationKey("Enter")).toBe(true)
    expect(isActivationKey(" ")).toBe(true)
  })

  test("other keys do not activate", () => {
    expect(isActivationKey("Tab")).toBe(false)
    expect(isActivationKey("ArrowDown")).toBe(false)
    expect(isActivationKey("Spacebar")).toBe(false)
  })
})
