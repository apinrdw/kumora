// Dragging a bubble on Market Bubbles (spec apinrdw/kumora#427, "Drag"): the
// held bubble follows the pointer and never yields; on release it keeps a
// little of the drag's speed and eases home on a soft, damped pull, so it
// never swings round its cluster.
import { Effect } from "effect"

// A press that moves no further than this, in CSS px, is a click.
export const CLICK_SLOP = 4

// The share of the drag's speed a released bubble keeps, and its cap in px a
// frame.
const RELEASE_SHARE = 0.2
export const RETURN_MAX_SPEED = 2.5
// The pull home after a release, its damping, and for how many frames.
export const RETURN_PULL = 0.004
export const RETURN_DAMPING = 0.82
export const RETURN_FRAMES = 90

// A velocity, in CSS px a frame.
export interface Velocity {
  readonly vx: number
  readonly vy: number
}

// What a released bubble keeps of the pointer's last `drag` velocity.
export const releaseVelocity = (drag: Velocity) =>
  Effect.sync((): Velocity => {
    const speed = Math.hypot(drag.vx, drag.vy)
    if (speed === 0) return { vx: 0, vy: 0 }
    const keep = Math.min(RELEASE_SHARE, RETURN_MAX_SPEED / speed)
    return { vx: drag.vx * keep, vy: drag.vy * keep }
  })
