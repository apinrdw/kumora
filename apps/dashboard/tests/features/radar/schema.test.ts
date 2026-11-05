import { Schema } from "effect"
import { describe, expect, test } from "vitest"

import { RADAR_SNAPSHOT } from "@/features/radar/data"
import { RadarSnapshot } from "@/features/radar/schema"

const decode = Schema.decodeUnknownSync(RadarSnapshot)

describe("RadarSnapshot", () => {
  test("decodes the full radar fixture snapshot", () => {
    expect(decode(RADAR_SNAPSHOT)).toEqual(RADAR_SNAPSHOT)
  })

  test("rejects a candidate with a malformed Symbol", () => {
    const bad = {
      ...RADAR_SNAPSHOT,
      candidates: [{ ...RADAR_SNAPSHOT.candidates[0], symbol: "bb" }],
    }
    expect(() => decode(bad)).toThrow(/symbol/)
  })
})
