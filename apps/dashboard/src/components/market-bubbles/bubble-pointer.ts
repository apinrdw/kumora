// Hover, drag and click on Market Bubbles' canvas (spec apinrdw/kumora#427,
// "Hover" and "Drag"), as listeners the canvas's frame loop attaches.
import type { SectorName, StockCode } from "@workspace/relay"
import { Effect } from "effect"

import { CLICK_SLOP, releaseVelocity, RETURN_FRAMES } from "@/lib/bubble-drag"
import type { BubbleFigures } from "@/lib/bubbles"

// What the pointer needs of a bubble on the canvas: where it is and how big,
// its velocity, to fling it on release, and its frames left of the return.
interface PointerBody {
  readonly code: StockCode
  readonly x: number
  readonly y: number
  readonly r: number
  // The radius drawn: r, or the hover's 1.7×, eased.
  readonly shownR: number
  readonly leaving: boolean
  readonly figures: BubbleFigures
  vx: number
  vy: number
  returning: number
}

// A press on a bubble, in CSS px within the canvas: where it began, where
// the pointer is and how fast it moves (px a frame), and whether it has
// moved past a click.
interface Press {
  readonly code: StockCode
  readonly fromX: number
  readonly fromY: number
  x: number
  y: number
  vx: number
  vy: number
  at: number
  moved: boolean
}

// What the frame loop reads each frame: the hovered code, which it grows,
// and the press, whose bubble it holds under the pointer once dragged.
export interface Pointer {
  hovered: StockCode | undefined
  press: Press | undefined
}

// What a pointer is over, for the tooltip.
export interface Hovered {
  readonly figures: BubbleFigures
  readonly x: number
  readonly y: number
  // The canvas's size, to keep the tooltip inside it.
  readonly width: number
  readonly height: number
}

// What the component renders of the pointer: the tooltip and the cursor.
export interface PointerView {
  readonly tip: Hovered | undefined
  readonly cursor: "default" | "pointer" | "grabbing"
}

export const NO_POINTER: PointerView = { tip: undefined, cursor: "default" }

// A pointer's move, in ms, as one frame.
const FRAME_MS = 16

// The press being dragged, once it has moved past a click.
export const draggedOf = (pointer: Pointer) =>
  Effect.sync(() => (pointer.press?.moved === true ? pointer.press : undefined))

// The hovered bubble's circle as drawn on a `width` × `height` canvas: grown,
// its centre moved in so all of it shows. The canvas draws it and the
// pointer hits it here.
export const liftedCircle = (
  body: Pick<PointerBody, "x" | "y" | "shownR">,
  width: number,
  height: number
) =>
  Effect.sync(() => {
    const r = body.shownR
    return {
      x: Math.min(Math.max(body.x, r), width - r),
      y: Math.min(Math.max(body.y, r), height - r),
      r,
    }
  })

// The bubble under a point on a `width` × `height` canvas: the hovered one
// while the point is inside its grown circle, so moving over it never
// flickers to a neighbour it covers, else the smallest when they overlap.
const bubbleAt = <Body extends PointerBody>(
  bodies: ReadonlyMap<StockCode, Body>,
  hovered: StockCode | undefined,
  at: { x: number; y: number; width: number; height: number }
) =>
  Effect.gen(function* () {
    const within = (circle: { x: number; y: number; r: number }) =>
      Math.hypot(circle.x - at.x, circle.y - at.y) <= circle.r
    const hovering = hovered === undefined ? undefined : bodies.get(hovered)
    if (
      hovering !== undefined &&
      !hovering.leaving &&
      within(yield* liftedCircle(hovering, at.width, at.height))
    )
      return hovering
    let found: Body | undefined
    for (const body of bodies.values())
      if (
        !body.leaving &&
        within(body) &&
        (found === undefined || body.r < found.r)
      )
        found = body
    return found
  })

// A drag's bubble let go: it keeps a little of the drag's speed and eases
// home.
const fling = (body: PointerBody, held: Press) =>
  Effect.map(releaseVelocity(held), ({ vx, vy }) => {
    body.vx = vx
    body.vy = vy
    body.returning = RETURN_FRAMES
  })

// Follows the pointer on `surface` over `bodies` until the returned cleanup.
// Hovering a bubble names it in `pointer` and shows its tooltip; a press that
// moves past CLICK_SLOP drags it, captured so the drag follows the pointer
// outside the canvas; a press that doesn't hands its code to `pick`. A
// finger has no hover, so its tap names and grows the bubble, and only a tap
// on the bubble it already names picks it; a tap off the bubbles clears it. A click
// on the sector label `labelAt` finds hands its sector to `pickSector`; a
// label is above its cluster, so it is tried first.
export function followPointer<Body extends PointerBody>({
  surface,
  bodies,
  pointer,
  show,
  pick,
  labelAt,
  pickSector,
}: {
  surface: HTMLCanvasElement
  bodies: ReadonlyMap<StockCode, Body>
  pointer: Pointer
  show: (view: PointerView) => void
  pick: (code: StockCode) => void
  labelAt: (x: number, y: number) => SectorName | undefined
  pickSector: (sector: SectorName) => void
}) {
  // A press on a sector label: which, and where it began.
  let onLabel: { sector: SectorName; x: number; y: number } | undefined
  const pointAt = (event: PointerEvent) => {
    const box = surface.getBoundingClientRect()
    return {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      width: box.width,
      height: box.height,
    }
  }
  const hover = (
    body: PointerBody | undefined,
    at: ReturnType<typeof pointAt>
  ) => {
    pointer.hovered = body?.code
    if (body !== undefined)
      return show({ tip: { figures: body.figures, ...at }, cursor: "pointer" })
    show(
      labelAt(at.x, at.y) === undefined
        ? NO_POINTER
        : { tip: undefined, cursor: "pointer" }
    )
  }

  const down = (event: PointerEvent) => {
    const at = pointAt(event)
    const sector = labelAt(at.x, at.y)
    if (sector !== undefined) {
      onLabel = { sector, x: at.x, y: at.y }
      return
    }
    const body = Effect.runSync(bubbleAt(bodies, pointer.hovered, at))
    if (body === undefined) {
      if (event.pointerType === "touch") hover(undefined, at)
      return
    }
    surface.setPointerCapture(event.pointerId)
    pointer.press = {
      code: body.code,
      fromX: at.x,
      fromY: at.y,
      x: at.x,
      y: at.y,
      vx: 0,
      vy: 0,
      at: event.timeStamp,
      moved: false,
    }
  }

  // The dragged bubble follows the pointer, at its speed in px a frame; past
  // CLICK_SLOP the press is a drag, and the hover and its tooltip go.
  const drag = (held: Press, event: PointerEvent) => {
    const at = pointAt(event)
    const frames = Math.max(1, event.timeStamp - held.at) / FRAME_MS
    held.vx = (at.x - held.x) / frames
    held.vy = (at.y - held.y) / frames
    held.x = at.x
    held.y = at.y
    held.at = event.timeStamp
    const far = Math.hypot(at.x - held.fromX, at.y - held.fromY) > CLICK_SLOP
    if (held.moved || !far) return
    held.moved = true
    pointer.hovered = undefined
    show({ tip: undefined, cursor: "grabbing" })
  }

  const move = (event: PointerEvent) => {
    if (pointer.press !== undefined) return drag(pointer.press, event)
    const at = pointAt(event)
    hover(Effect.runSync(bubbleAt(bodies, pointer.hovered, at)), at)
  }

  // A finger leaves as it lifts: what its tap named stays.
  const leave = (event: PointerEvent) => {
    if (pointer.press === undefined && event.pointerType !== "touch")
      hover(undefined, pointAt(event))
  }

  // A click picks its bubble; a finger's tap picks only the bubble it
  // already names, and names any other.
  const click = (body: PointerBody, event: PointerEvent) => {
    if (event.pointerType !== "touch" || pointer.hovered === body.code)
      return pick(body.code)
    hover(body, pointAt(event))
  }

  // A press that never moved past CLICK_SLOP is a click; a drag lets its
  // bubble go.
  const release = (event: PointerEvent) => {
    const label = onLabel
    onLabel = undefined
    if (label !== undefined && event.type === "pointerup") {
      const at = pointAt(event)
      if (Math.hypot(at.x - label.x, at.y - label.y) <= CLICK_SLOP)
        pickSector(label.sector)
    }
    const held = pointer.press
    pointer.press = undefined
    if (held === undefined) return
    if (held.moved) show(NO_POINTER)
    const body = bodies.get(held.code)
    if (body === undefined) return
    if (held.moved) return Effect.runSync(fling(body, held))
    if (event.type === "pointerup") click(body, event)
  }

  const listeners = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerleave", leave],
    ["pointerup", release],
    ["pointercancel", release],
  ] as const
  for (const [type, listener] of listeners)
    surface.addEventListener(type, listener)
  return () => {
    for (const [type, listener] of listeners)
      surface.removeEventListener(type, listener)
  }
}
