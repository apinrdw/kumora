// @vitest-environment happy-dom
import { StockCode } from "@workspace/relay"
import { expect, test, vi } from "vitest"

import {
  followPointer,
  type Pointer,
  type PointerView,
} from "@/components/market-bubbles/bubble-pointer"
import type { BubbleFigures } from "@/lib/bubbles"

const code = StockCode.make("BBCA")

const figures: BubbleFigures = {
  code,
  value: 1,
  volume: 1,
  frequency: 1,
  buyValue: 0,
  sellValue: 0,
  buySellDelta: 0,
  change: undefined,
  dayChange: undefined,
  last: 100,
  size: 1,
}

test("a hovered bubble grown past the canvas's edge is hit where it is drawn", () => {
  const surface = document.createElement("canvas")
  surface.getBoundingClientRect = () => new DOMRect(0, 0, 200, 200)
  // Centred 7 px from the left edge and grown to 34 px, it is drawn at
  // x = 34, so x = 60 is inside it and 53 px from its centre.
  const bodies = new Map([
    [
      code,
      {
        code,
        x: 7,
        y: 100,
        r: 20,
        shownR: 34,
        leaving: false,
        figures,
        vx: 0,
        vy: 0,
        returning: 0,
      },
    ],
  ])
  const pointer: Pointer = { hovered: code, press: undefined }
  const show = vi.fn<(view: PointerView) => void>()
  const unfollow = followPointer({
    surface,
    bodies,
    pointer,
    show,
    pick: () => {},
    labelAt: () => undefined,
    pickSector: () => {},
  })
  surface.dispatchEvent(
    new PointerEvent("pointermove", { clientX: 60, clientY: 100 })
  )
  unfollow()
  expect(pointer.hovered).toBe(code)
  expect(show).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "pointer" })
  )
})
