import { describe, expect, it } from "vitest"

import { recording } from "./video"

const FILES = [
  "account.spec.ts",
  "sign-in.spec.ts",
  "market-live.spec.ts",
  "market-live-select.spec.ts",
  "relay-load.spec.ts",
  "accounts.setup.ts",
]

describe("recording", () => {
  it("records nothing while the switch is unset or empty", () => {
    const none = { chromium: [], tradingDay: false }
    expect(recording(undefined, FILES)).toEqual(none)
    expect(recording("", FILES)).toEqual(none)
  })

  it("records only the picked chromium spec", () => {
    expect(recording("account.spec.ts", FILES)).toEqual({
      chromium: ["account.spec.ts"],
      tradingDay: false,
    })
  })

  it("reads a spec as the evidence command takes it: a name or a path ending in one", () => {
    for (const typed of [
      "apps/e2e/tests/account.spec.ts",
      "tests/account.spec.ts",
      "/home/me/kumora/apps/e2e/tests/account.spec.ts",
    ])
      expect(recording(typed, FILES).chromium).toEqual(["account.spec.ts"])
  })

  it("records the whole trading-day project when one of its specs is picked", () => {
    expect(recording("market-live-select.spec.ts", FILES)).toEqual({
      chromium: [],
      tradingDay: true,
    })
  })

  it("never records the relay-load spec", () => {
    expect(recording("relay-load.spec.ts,account.spec.ts", FILES)).toEqual({
      chromium: ["account.spec.ts"],
      tradingDay: false,
    })
  })

  it("takes several picked specs, comma-separated", () => {
    expect(
      recording("sign-in.spec.ts,market-live.spec.ts,account.spec.ts", FILES)
    ).toEqual({
      chromium: ["account.spec.ts", "sign-in.spec.ts"],
      tradingDay: true,
    })
  })

  it("fails on a value that names no spec file", () => {
    expect(() => recording("on", FILES)).toThrow(/E2E_VIDEO="on"/)
    expect(() => recording("account.spec.ts,gone.spec.ts", FILES)).toThrow(
      /gone\.spec\.ts/
    )
    // Part of a name is not the name.
    expect(() => recording("ount.spec.ts", FILES)).toThrow(/ount\.spec\.ts/)
    // Nor is a longer name that ends in it, without a folder between.
    expect(() => recording("my-account.spec.ts", FILES)).toThrow(
      /my-account\.spec\.ts/
    )
    expect(() => recording("accounts.setup.ts", FILES)).toThrow(
      /accounts\.setup\.ts/
    )
  })
})
