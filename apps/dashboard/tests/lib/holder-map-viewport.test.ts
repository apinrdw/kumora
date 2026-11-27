import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  fitViewport,
  panViewport,
  viewportDomains,
  zoomViewport,
} from "@/lib/holder-map-viewport"

const size = { width: 800, height: 400 }
const extent = { x: [-100, 300], y: [-50, 50] } as const

describe("Holder map viewport", () => {
  it.effect("fits the whole extent, filling the tighter side", () =>
    Effect.gen(function* () {
      const domains = yield* viewportDomains(
        yield* fitViewport(extent, size),
        size
      )
      // 400 wide in 800 px: 0.5 units a px, so 200 units tall in 400 px.
      expect(domains.x).toEqual([-100, 300])
      expect(domains.y).toEqual([-100, 100])
    })
  )

  it.effect(
    "zooms in round the pointer, keeping the point under it in place",
    () =>
      Effect.gen(function* () {
        const fitted = yield* fitViewport(extent, size)
        const zoomed = yield* zoomViewport(fitted, size, { x: 200, y: 100 }, 2)
        const before = yield* viewportDomains(fitted, size)
        const after = yield* viewportDomains(zoomed, size)
        // The pointer sat at (0, -50) and still does.
        expect(before.x[0] + 200 * 0.5).toBe(0)
        expect(after.x[0] + 200 * 0.25).toBe(0)
        expect(after.y[0] + 100 * 0.25).toBe(-50)
        expect(after.x[1] - after.x[0]).toBe(200)
      })
  )

  it.effect("pans with the drag, so the map follows the pointer", () =>
    Effect.gen(function* () {
      const fitted = yield* fitViewport(extent, size)
      const panned = yield* panViewport(fitted, { x: 40, y: -20 })
      const domains = yield* viewportDomains(panned, size)
      expect(domains.x).toEqual([-120, 280])
      expect(domains.y).toEqual([-90, 110])
    })
  )

  it.effect("keeps a zoom within its limits", () =>
    Effect.gen(function* () {
      const fitted = yield* fitViewport(extent, size)
      const far = yield* zoomViewport(fitted, size, { x: 0, y: 0 }, 1e9)
      const out = yield* zoomViewport(fitted, size, { x: 0, y: 0 }, 1e-9)
      expect(far.unit).toBeGreaterThan(0)
      expect(Number.isFinite(out.unit)).toBe(true)
    })
  )
})
