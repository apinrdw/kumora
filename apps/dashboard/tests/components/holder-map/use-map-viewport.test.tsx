// @vitest-environment happy-dom
import { act, type PointerEvent, useRef } from "react"
import { createRoot } from "react-dom/client"
import { expect, test } from "vitest"

import { useMapViewport } from "@/components/holder-map/use-map-viewport"
import type { Extent } from "@/lib/holder-map-layout"

// React's `act` warns outside a test environment that declares itself.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const EXTENT: Extent = { x: [-100, 100], y: [-50, 50] }
const SIZE = { width: 400, height: 200 }

// The hook as the map uses it, its latest result kept for the test.
const mount = () => {
  const latest: { current?: ReturnType<typeof useMapViewport> } = {}
  function Map() {
    const frame = useRef<HTMLDivElement>(null)
    latest.current = useMapViewport(frame, EXTENT, SIZE)
    return <div ref={frame} />
  }
  const root = createRoot(document.createElement("div"))
  act(() => root.render(<Map />))
  return latest
}

// A pointer event on the frame at (x, y), with `buttons` held.
const at = (x: number, y: number, buttons: number) => {
  const frame = document.createElement("div")
  frame.setPointerCapture = () => {}
  return {
    button: 0,
    buttons,
    clientX: x,
    clientY: y,
    pointerId: 1,
    currentTarget: frame,
  } as unknown as PointerEvent<HTMLDivElement>
}

type Handler = (event: PointerEvent<HTMLDivElement>) => void

// The frame's `on<name>` handler, if it has one, fired with `event`.
const fire = (
  viewport: { current?: ReturnType<typeof useMapViewport> },
  name: string,
  event: PointerEvent<HTMLDivElement>
) => {
  const handlers: Partial<Record<string, Handler>> =
    viewport.current?.frameHandlers ?? {}
  act(() => handlers[`on${name}`]?.(event))
}

test("a press released outside the frame before it became a drag pans nothing when the pointer comes back", () => {
  const viewport = mount()
  const fitted = viewport.current?.view
  fire(viewport, "PointerDown", at(100, 100, 1))
  // Within the click slop, so the pointer isn't captured yet.
  fire(viewport, "PointerMove", at(102, 100, 1))
  // It leaves the frame and the button comes up outside: no pointerup here.
  fire(viewport, "PointerLeave", at(150, 100, 1))
  // Back over the map with no button pressed.
  fire(viewport, "PointerMove", at(200, 100, 0))
  expect(viewport.current?.view).toEqual(fitted)
})

test("a move with no primary button pressed pans nothing, though a press began", () => {
  const viewport = mount()
  const fitted = viewport.current?.view
  fire(viewport, "PointerDown", at(100, 100, 1))
  fire(viewport, "PointerMove", at(200, 100, 0))
  expect(viewport.current?.view).toEqual(fitted)
})

test("a drag with the button held pans the map", () => {
  const viewport = mount()
  const fitted = viewport.current?.view
  fire(viewport, "PointerDown", at(100, 100, 1))
  fire(viewport, "PointerMove", at(200, 100, 1))
  expect(viewport.current?.view).not.toEqual(fitted)
})
