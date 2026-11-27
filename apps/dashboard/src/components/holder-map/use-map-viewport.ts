// The Holder map's own pan and zoom (lib/holder-map-viewport.ts): the
// wheel zooms round the pointer, a drag pans, and a new extent to fit (a
// new layout, or the Off list toggled) starts fitted to view.
import { Effect } from "effect"
import {
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
  const drag = useRef<{ x: number; y: number; dragging: boolean }>(undefined)
  // Set by a drag, so the click that ends it refocuses nothing.
  const dragged = useRef(false)

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
    // True once, for the click that ends a drag.
    endedDrag: () => {
      const was = dragged.current
      dragged.current = false
      return was
    },
    frameHandlers: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return
        drag.current = { x: event.clientX, y: event.clientY, dragging: false }
        dragged.current = false
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        const start = drag.current
        if (start === undefined) return
        // The button came up where the frame never heard it: no drag.
        if ((event.buttons & 1) === 0) {
          drag.current = undefined
          return
        }
        const by = { x: event.clientX - start.x, y: event.clientY - start.y }
        if (!start.dragging && Math.hypot(by.x, by.y) <= CLICK_SLOP) return
        if (!start.dragging) {
          // Captured only once it is a drag, so a click still reaches the
          // chart.
          event.currentTarget.setPointerCapture(event.pointerId)
          dragged.current = true
        }
        drag.current = { x: event.clientX, y: event.clientY, dragging: true }
        move((current) => Effect.runSync(panViewport(current, by)))
      },
      onPointerUp: () => {
        drag.current = undefined
      },
      onPointerCancel: () => {
        drag.current = undefined
      },
      // A press not yet a drag isn't captured, so its pointerup may land
      // outside the frame: it ends on leaving.
      onPointerLeave: (event: PointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId))
          drag.current = undefined
      },
    },
  }
}
