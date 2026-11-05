import { describe, expect, test } from "vitest"

import { IsoDateTime } from "@/domain/time"
import { relayFreshness } from "@/relay/freshness"

const NOW = Date.parse("2026-10-29T03:00:00Z")
const ago = (ms: number) => IsoDateTime.make(new Date(NOW - ms).toISOString())
const LONG_AGO = ago(3_600_000)

const stale = (reason: string) => ({ freshness: "stale", reason })
const LIVE = { freshness: "live", reason: null }

describe("relayFreshness", () => {
  test.each(["session-1", "break", "closed", "pre-open"] as const)(
    "a trade within 60 s reads live during %s",
    (phase) => {
      expect(relayFreshness(NOW, ago(59_999), "extension", phase)).toEqual(LIVE)
    }
  )

  test("a trade exactly 60 s old no longer counts", () => {
    expect(relayFreshness(NOW, ago(60_000), "extension", "session-1")).toEqual(
      stale("no-trades")
    )
  })

  test("closed after the close, before pre-open, or on a holiday", () => {
    expect(relayFreshness(NOW, LONG_AGO, "extension", "closed")).toEqual(
      stale("closed")
    )
  })

  test("break between the sessions", () => {
    expect(relayFreshness(NOW, LONG_AGO, "extension", "break")).toEqual(
      stale("break")
    )
  })

  test.each([
    "pre-open",
    "session-1",
    "session-2",
    "closing-auction",
    "post-closing",
  ] as const)("no-source during %s with no active source", (phase) => {
    expect(relayFreshness(NOW, LONG_AGO, "none", phase)).toEqual(
      stale("no-source")
    )
  })

  test.each([
    "pre-open",
    "session-1",
    "session-2",
    "closing-auction",
    "post-closing",
  ] as const)(
    "no-trades during %s with a source and nothing for 60 s",
    (phase) => {
      expect(relayFreshness(NOW, LONG_AGO, "extension", phase)).toEqual(
        stale("no-trades")
      )
    }
  )

  test("the calendar's reason comes before a missing source", () => {
    expect(relayFreshness(NOW, LONG_AGO, "none", "closed")).toEqual(
      stale("closed")
    )
    expect(relayFreshness(NOW, LONG_AGO, "none", "break")).toEqual(
      stale("break")
    )
  })

  test("a recent trade with no source left is not live", () => {
    expect(relayFreshness(NOW, ago(1000), "none", "session-1")).toEqual(
      stale("no-source")
    )
  })

  test("a relay that has never had a trade is stale", () => {
    expect(relayFreshness(NOW, null, "extension", "session-1")).toEqual(
      stale("no-trades")
    )
  })

  test("the relay's own session counts as a source", () => {
    expect(relayFreshness(NOW, ago(1000), "upstream", "session-1")).toEqual(
      LIVE
    )
  })
})
