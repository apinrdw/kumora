import { describe, expect, it } from "vitest"

import { recording } from "./video"

const FILES = [
  "account.spec.ts",
  "sign-in.spec.ts",
  "market-live.spec.ts",
  "market-live-select.spec.ts",
  "relay-load.spec.ts",
  "cold-day.spec.ts",
  "holder-moves.spec.ts",
  "repaint-bench.spec.ts",
  "accounts.setup.ts",
]

describe("recording", () => {
  it("records nothing while the switch is unset or empty", () => {
    const none = {
      chromium: [],
      tradingDay: false,
      coldDay: false,
      holderMoves: false,
    }
    expect(recording(undefined, FILES)).toEqual(none)
    expect(recording("", FILES)).toEqual(none)
  })

  it("records only the picked chromium spec", () => {
    expect(recording("account.spec.ts", FILES)).toEqual({
      chromium: ["account.spec.ts"],
      tradingDay: false,
      coldDay: false,
      holderMoves: false,
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
      coldDay: false,
      holderMoves: false,
    })
  })

  it("records the cold-day project, not chromium, when its spec is picked", () => {
    expect(recording("cold-day.spec.ts,account.spec.ts", FILES)).toEqual({
      chromium: ["account.spec.ts"],
      tradingDay: false,
      coldDay: true,
      holderMoves: false,
    })
  })

  it("records the holder-moves project, not chromium, when its spec is picked", () => {
    expect(recording("holder-moves.spec.ts", FILES)).toEqual({
      chromium: [],
      tradingDay: false,
      coldDay: false,
      holderMoves: true,
    })
  })

  it("never records the relay-load spec", () => {
    expect(recording("relay-load.spec.ts,account.spec.ts", FILES)).toEqual({
      chromium: ["account.spec.ts"],
      tradingDay: false,
      coldDay: false,
      holderMoves: false,
    })
  })

  it("never records the repaint bench", () => {
    expect(recording("repaint-bench.spec.ts,account.spec.ts", FILES)).toEqual({
      chromium: ["account.spec.ts"],
      tradingDay: false,
      coldDay: false,
      holderMoves: false,
    })
  })

  it("takes several picked specs, comma-separated", () => {
    expect(
      recording("sign-in.spec.ts,market-live.spec.ts,account.spec.ts", FILES)
    ).toEqual({
      chromium: ["account.spec.ts", "sign-in.spec.ts"],
      tradingDay: true,
      coldDay: false,
      holderMoves: false,
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
