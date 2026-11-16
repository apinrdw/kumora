// The snapshot button's work (spec apinrdw/kumora#427, "Snapshot"): the map's
// canvas, logos and all, over a caption strip, saved as a PNG.
import { Data, Effect } from "effect"

import { snapshotCaption, snapshotName } from "@/lib/bubble-snapshot"
import type { BubbleView } from "@/lib/bubbles"

// The caption strip's height, in CSS px.
const CAPTION = 34
const PAD = 12

class SnapshotFailed extends Data.TaggedError("SnapshotFailed")<{
  readonly reason: string
}> {}

// `surface` drawn on the canvas colour, with `caption` under it: the title in
// bold, then its other parts, at the canvas's own pixel ratio.
const compose = (surface: HTMLCanvasElement, caption: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const ratio = surface.width / Math.max(1, surface.clientWidth)
    const out = document.createElement("canvas")
    out.width = surface.width
    out.height = surface.height + Math.round(CAPTION * ratio)
    const context = out.getContext("2d")
    if (context === null) return undefined
    const css = getComputedStyle(document.documentElement)
    const token = (name: string) => css.getPropertyValue(name).trim()
    const font = getComputedStyle(surface).fontFamily
    context.fillStyle = token("--bubble-snapshot")
    context.fillRect(0, 0, out.width, out.height)
    context.drawImage(surface, 0, 0)
    context.setTransform(ratio, 0, 0, ratio, 0, surface.height)
    context.fillStyle = token("--bubble-caption")
    context.fillRect(0, 0, surface.clientWidth, CAPTION)
    context.textBaseline = "middle"
    const [title = "", ...rest] = caption
    context.font = `800 13px ${font}`
    context.fillStyle = token("--bubble-label")
    context.fillText(title, PAD, CAPTION / 2)
    const after = PAD + context.measureText(title).width + PAD
    context.font = `600 12px ${font}`
    context.fillStyle = token("--bubble-label-muted")
    context.fillText(rest.join("  ·  "), after, CAPTION / 2)
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
