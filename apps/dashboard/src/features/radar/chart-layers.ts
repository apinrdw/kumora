// What the live chart draws behind its candles, as series primitives of `lightweight-charts`:
// the source gaps, the break between sessions, and the session's volume profile.
import type {
  IPrimitivePaneView,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts"

import type { ProfileRow } from "./profile-rows"

type Size = { readonly width: number; readonly height: number }

type Paint<T> = (
  ctx: CanvasRenderingContext2D,
  size: Size,
  attachedTo: SeriesAttachedParameter<Time>,
  data: T
) => void

/** One primitive drawn under the candles from data the chart replaces whole. */
export class ChartLayer<T> implements ISeriesPrimitive<Time> {
  private attachedTo: SeriesAttachedParameter<Time> | null = null
  private readonly views: ReadonlyArray<IPrimitivePaneView>

  constructor(
    private data: T,
    paint: Paint<T>
  ) {
    this.views = [
      {
        zOrder: () => "bottom",
        renderer: () => ({
          draw: (target) => {
            const { attachedTo } = this
            if (attachedTo === null) return
            target.useMediaCoordinateSpace(({ context, mediaSize }) =>
              paint(context, mediaSize, attachedTo, this.data)
            )
          },
        }),
      },
    ]
  }

  attached(attachedTo: SeriesAttachedParameter<Time>) {
    this.attachedTo = attachedTo
  }

  detached() {
    this.attachedTo = null
  }

  paneViews() {
    return this.views
  }

  set(data: T) {
    this.data = data
    this.attachedTo?.requestUpdate()
  }
}

export type SessionMarks = {
  /** Slots the relay had no source for. */
  readonly gaps: ReadonlyArray<Time>
  /** The second session's first slot, which a line sets apart from the first. */
  readonly divider: Time | null
  readonly gapColor: string
  readonly dividerColor: string
}

/** The chart key draws its swatches at these too. */
export const GAP_ALPHA = 0.14

export const paintSessionMarks: Paint<SessionMarks> = (
  ctx,
  { height },
  { chart },
  sessionMarks
) => {
  const scale = chart.timeScale()
  const half = scale.options().barSpacing / 2
  ctx.save()
  ctx.globalAlpha = GAP_ALPHA
  ctx.fillStyle = sessionMarks.gapColor
  for (const time of sessionMarks.gaps) {
    const x = scale.timeToCoordinate(time)
    if (x !== null) ctx.fillRect(x - half, 0, half * 2, height)
  }
  ctx.restore()
  const x =
    sessionMarks.divider === null
      ? null
      : scale.timeToCoordinate(sessionMarks.divider)
  if (x === null) return
  ctx.save()
  ctx.strokeStyle = sessionMarks.dividerColor
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(Math.round(x - half) + 0.5, 0)
  ctx.lineTo(Math.round(x - half) + 0.5, height)
  ctx.stroke()
  ctx.restore()
}

export type Profile = {
  readonly rows: ReadonlyArray<ProfileRow>
  readonly buyColor: string
  readonly sellColor: string
  readonly unspecifiedColor: string
}

/** The widest row's share of the pane, from its right edge. */
const PROFILE_WIDTH = 0.22
export const PROFILE_ALPHA = 0.22

export const paintProfile: Paint<Profile> = (
  ctx,
  { width },
  { series },
  { rows, buyColor, sellColor, unspecifiedColor }
) => {
  const widest = Math.max(0, ...rows.map((r) => r.buy + r.sell + r.unspecified))
  if (widest === 0) return
  const scale = (width * PROFILE_WIDTH) / widest
  ctx.save()
  ctx.globalAlpha = PROFILE_ALPHA
  for (const row of rows) {
    const top = series.priceToCoordinate(row.to)
    const bottom = series.priceToCoordinate(row.from)
    if (top === null || bottom === null) continue
    const h = Math.max(1, bottom - top - 1)
    let right = width
    for (const [lots, color] of [
      [row.buy, buyColor],
      [row.sell, sellColor],
      [row.unspecified, unspecifiedColor],
    ] as const) {
      const w = lots * scale
      ctx.fillStyle = color
      ctx.fillRect(right - w, top, w, h)
      right -= w
    }
  }
  ctx.restore()
}
