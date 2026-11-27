// The Holder map's own 2D pan and zoom (spec apinrdw/kumora#733,
// "Rendering"): the library zooms horizontally only, so the page keeps a
// viewport, a centre and a scale in layout units per CSS px, and remaps
// both scales' domains from it. The y domain runs downward, as the screen
// does, with the chart's y scale reversed.
import { Effect } from "effect"

export interface Viewport {
  readonly cx: number
  readonly cy: number
  // Layout units per CSS px: smaller is closer.
  readonly unit: number
}

interface Size {
  readonly width: number
  readonly height: number
}

interface Point {
  readonly x: number
  readonly y: number
}

type Range = readonly [number, number]

// A zoom's limits: in this close and out this far, in layout units per px.
const CLOSEST = 0.01
const FARTHEST = 1000

// The viewport that shows the whole extent, centred.
export const fitViewport = (
  extent: { readonly x: Range; readonly y: Range },
  size: Size
) =>
  Effect.sync((): Viewport => ({
    cx: (extent.x[0] + extent.x[1]) / 2,
    cy: (extent.y[0] + extent.y[1]) / 2,
    unit: Math.max(
      (extent.x[1] - extent.x[0]) / Math.max(1, size.width),
      (extent.y[1] - extent.y[0]) / Math.max(1, size.height)
    ),
  }))

// Zoomed in by `factor` (out below 1) round `at`, a point in px from the
// chart's top left, which stays over the same layout point.
export const zoomViewport = (
  view: Viewport,
  size: Size,
  at: Point,
  factor: number
) =>
  Effect.sync((): Viewport => {
    const unit = Math.min(FARTHEST, Math.max(CLOSEST, view.unit / factor))
    const fromCentre = { x: at.x - size.width / 2, y: at.y - size.height / 2 }
    const under = {
      x: view.cx + fromCentre.x * view.unit,
      y: view.cy + fromCentre.y * view.unit,
    }
    return {
      cx: under.x - fromCentre.x * unit,
      cy: under.y - fromCentre.y * unit,
      unit,
    }
  })

// Moved by a drag of `by` px: the map follows the pointer.
export const panViewport = (view: Viewport, by: Point) =>
  Effect.sync((): Viewport => ({
    ...view,
    cx: view.cx - by.x * view.unit,
    cy: view.cy - by.y * view.unit,
  }))

// The x and y scale domains the viewport shows at this size.
export const viewportDomains = (view: Viewport, size: Size) =>
  Effect.sync(() => {
    const halfWidth = (size.width / 2) * view.unit
    const halfHeight = (size.height / 2) * view.unit
    return {
      x: [view.cx - halfWidth, view.cx + halfWidth] as Range,
      y: [view.cy - halfHeight, view.cy + halfHeight] as Range,
    }
  })
