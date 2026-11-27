// The Holder map's own pan and zoom (lib/holder-map-viewport.ts): the
// wheel zooms round the pointer, a drag pans, and a new extent to fit (a
// new layout, or the Off list toggled) starts fitted to view.
import { Effect } from "effect"
import {
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { CLICK_SLOP } from "@/lib/bubble-drag"
import type { Extent } from "@/lib/holder-map-layout"
import {
  fitViewport,
  panViewport,
  type Viewport,
  zoomViewport,
} from "@/lib/holder-map-viewport"

// One wheel notch's zoom, per px of its delta.
const WHEEL_ZOOM = 0.0015

interface Size {
  readonly width: number
  readonly height: number
}

// The frame's one pointer gesture, the only place a press or drag is kept:
// none; a press not yet past the click slop, which may still be a click on
// a node; a drag, panning from its last point; or a drag just released,
// whose click the frame swallows. Every pointerdown starts it afresh, and a
// cancel ends it, so no gesture outlives the next. A keyboard selection
// never reads it.
type Gesture =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Pressed"; readonly x: number; readonly y: number }
  | { readonly _tag: "Dragging"; readonly x: number; readonly y: number }
  | { readonly _tag: "Released" }

const IDLE: Gesture = { _tag: "Idle" }

export function useMapViewport(
  frame: RefObject<HTMLDivElement | null>,
  extent: Extent | undefined,
  size: Size | undefined
) {
  const fitted = useMemo(
    () =>
      extent === undefined || size === undefined
        ? undefined
        : Effect.runSync(fitViewport(extent, size)),
    [extent, size]
  )
  // The viewport the reader moved to, for the extent it was moved over.
  const [moved, setMoved] = useState<{ extent: Extent; view: Viewport }>()
  const view =
    moved !== undefined && moved.extent === extent ? moved.view : fitted
  const gesture = useRef<Gesture>(IDLE)

  // Functional, so moves between two renders (a fast wheel) add up.
  const move = (next: (current: Viewport) => Viewport) => {
    if (extent === undefined || fitted === undefined) return
    setMoved((previous) => ({
      extent,
      view: next(previous?.extent === extent ? previous.view : fitted),
    }))
  }

  // React's wheel listener is passive, and the page would scroll too.
  useEffect(() => {
    const current = frame.current
    if (current === null || extent === undefined) return
    if (fitted === undefined || size === undefined) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = current.getBoundingClientRect()
      const at = { x: event.clientX - box.left, y: event.clientY - box.top }
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM)
      setMoved((previous) => ({
        extent,
        view: Effect.runSync(
          zoomViewport(
            previous?.extent === extent ? previous.view : fitted,
            size,
            at,
            factor
          )
        ),
      }))
    }
    current.addEventListener("wheel", onWheel, { passive: false })
    return () => current.removeEventListener("wheel", onWheel)
  }, [frame, extent, fitted, size])

  return {
    view,
    // Zoomed by `factor` round the map's centre.
    zoom: (factor: number) =>
      size &&
      move((current) =>
        Effect.runSync(
          zoomViewport(
            current,
            size,
            { x: size.width / 2, y: size.height / 2 },
            factor
          )
        )
      ),
    fit: () => setMoved(undefined),
    frameHandlers: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        gesture.current =
          event.button === 0
            ? { _tag: "Pressed", x: event.clientX, y: event.clientY }
            : IDLE
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        const at = gesture.current
        if (at._tag !== "Pressed" && at._tag !== "Dragging") return
        // The button came up where the frame never heard it: no drag.
        if ((event.buttons & 1) === 0) {
          gesture.current = IDLE
          return
        }
        const by = { x: event.clientX - at.x, y: event.clientY - at.y }
        if (at._tag === "Pressed") {
          if (Math.hypot(by.x, by.y) <= CLICK_SLOP) return
          // Captured only once it is a drag, so a click still reaches the
          // chart.
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        gesture.current = {
          _tag: "Dragging",
          x: event.clientX,
          y: event.clientY,
        }
        move((current) => Effect.runSync(panViewport(current, by)))
      },
      onPointerUp: () => {
        gesture.current =
          gesture.current._tag === "Dragging" ? { _tag: "Released" } : IDLE
      },
      onPointerCancel: () => {
        gesture.current = IDLE
      },
      // A press not yet a drag isn't captured, so its pointerup may land
      // outside the frame: it ends on leaving.
      onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
        if (
          gesture.current._tag === "Pressed" &&
          !event.currentTarget.hasPointerCapture(event.pointerId)
        )
          gesture.current = IDLE
      },
      // In the capture phase, so the click that ends a drag never reaches
      // the chart, wherever the browser sends it.
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (gesture.current._tag !== "Released") return
        gesture.current = IDLE
        event.stopPropagation()
      },
    },
  }
}
