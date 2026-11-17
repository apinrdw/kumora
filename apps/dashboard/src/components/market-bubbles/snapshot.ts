// The snapshot button's work (spec apinrdw/kumora#427, "Snapshot"): the map's
// canvas, logos and all, over a caption strip, saved as a PNG.
import { Data, Effect } from "effect"

import {
  captionLines,
  snapshotCaption,
  snapshotName,
} from "@/lib/bubble-snapshot"
import type { BubbleView } from "@/lib/bubbles"

// The caption strip's line height, the room above and below its lines, and
// its side padding, in CSS px: one line is 34 px.
const LINE = 18
const EDGE = 8
const PAD = 12
const SEPARATOR = "  ·  "

class SnapshotFailed extends Data.TaggedError("SnapshotFailed")<{
  readonly reason: string
}> {}

// `surface` drawn on the canvas colour, with `caption` under it: the title in
// bold, then its other parts, wrapped to as many lines as the canvas's width
// needs, at the canvas's own pixel ratio.
const compose = Effect.fnUntraced(function* (
  surface: HTMLCanvasElement,
  caption: ReadonlyArray<string>
) {
  const width = surface.clientWidth
  const ratio = surface.width / Math.max(1, width)
  const out = document.createElement("canvas")
  const context = out.getContext("2d")
  if (context === null) return undefined
  const font = getComputedStyle(surface).fontFamily
  // The title's bold run is a little wider than the rest; measured as the
  // rest's, plus a character a part, so a line never runs past the edge.
  context.font = `800 13px ${font}`
  const measure = (text: string) => context.measureText(`${text}  `).width
  const lines = yield* captionLines(caption, width - 2 * PAD, measure)
  const strip = 2 * EDGE + lines.length * LINE
  out.width = surface.width
  out.height = surface.height + Math.round(strip * ratio)
  const css = getComputedStyle(document.documentElement)
  const token = (name: string) => css.getPropertyValue(name).trim()
  context.fillStyle = token("--bubble-snapshot")
  context.fillRect(0, 0, out.width, out.height)
  context.drawImage(surface, 0, 0)
  context.setTransform(ratio, 0, 0, ratio, 0, surface.height)
  context.fillStyle = token("--bubble-caption")
  context.fillRect(0, 0, width, strip)
  context.textBaseline = "middle"
  lines.forEach((line, index) => {
    const y = EDGE + (index + 0.5) * LINE
    let x = PAD
    line.forEach((part, at) => {
      const title = index === 0 && at === 0
      context.font = title ? `800 13px ${font}` : `600 12px ${font}`
      context.fillStyle = token(
        title ? "--bubble-label" : "--bubble-label-muted"
      )
      const text = at === 0 ? part : `${SEPARATOR}${part}`
      context.fillText(text, x, y)
      x += context.measureText(text).width
    })
  })
  return out
})

const pngOf = (canvas: HTMLCanvasElement) =>
  Effect.callback<Blob, SnapshotFailed>((resume) => {
    canvas.toBlob((blob) =>
      resume(
        blob === null
          ? Effect.fail(new SnapshotFailed({ reason: "No PNG made" }))
          : Effect.succeed(blob)
      )
    )
  })

// The blob's URL is let go a moment after the click, once the download has
// read it.
const save = (blob: Blob, name: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => URL.createObjectURL(blob)),
    (url) =>
      Effect.sync(() => {
        const link = document.createElement("a")
        link.href = url
        link.download = name
        link.click()
      }).pipe(Effect.andThen(Effect.sleep("1 second"))),
    (url) => Effect.sync(() => URL.revokeObjectURL(url))
  )

// Downloads the map on `surface` as shown at `at` (epoch ms) in `view`,
// captioned and named for that time.
export const snapshotMap = Effect.fnUntraced(function* (
  surface: HTMLCanvasElement,
  view: BubbleView,
  at: number
) {
  const composed = yield* compose(surface, yield* snapshotCaption(view, at))
  if (composed === undefined)
    return yield* new SnapshotFailed({ reason: "No 2D context" })
  yield* save(yield* pngOf(composed), yield* snapshotName(at))
})
