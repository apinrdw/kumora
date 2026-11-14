import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts"

// Draws the replay cursor as a 2-pixel vertical line at a logical bar
// position, over the candles. `host` takes the drawn x, its minute's centre
// and the bar spacing (CSS px) as data-cursor-x, data-cursor-minute-x and
// data-bar-spacing: the canvas has no text, and the page e2e reads them.
export class CursorLine implements ISeriesPrimitive<Time> {
  private logical: number | undefined
  private attachedTo: SeriesAttachedParameter<Time> | undefined
  private readonly renderer: IPrimitivePaneRenderer = {
    draw: (target) =>
      target.useBitmapCoordinateSpace((scope) => {
        const timeScale = this.attachedTo?.chart.timeScale()
        if (timeScale === undefined || this.logical === undefined) return
        // Decision: Lightweight Charts 5.2.1's logicalToCoordinate returns 0
        // for a fractional position, so the line starts from its whole
        // minute's coordinate and adds the fraction of the bar spacing.
        const whole = Math.floor(this.logical)
        const centre = timeScale.logicalToCoordinate(whole as Logical)
        if (centre === null) return
        const spacing = timeScale.options().barSpacing
        const x = centre + (this.logical - whole) * spacing
        this.host.dataset["cursorX"] = x.toFixed(2)
        this.host.dataset["cursorMinuteX"] = centre.toFixed(2)
        this.host.dataset["barSpacing"] = spacing.toFixed(2)
        scope.context.fillStyle = this.color
        const width = Math.max(2, Math.floor(2 * scope.horizontalPixelRatio))
        scope.context.fillRect(
          Math.round(x * scope.horizontalPixelRatio - width / 2),
          0,
          width,
          scope.bitmapSize.height
        )
      }),
  }
  private readonly views: ReadonlyArray<IPrimitivePaneView> = [
    { zOrder: () => "top", renderer: () => this.renderer },
  ]

  constructor(
    private readonly color: string,
    private readonly host: HTMLElement
  ) {}

  attached(parameter: SeriesAttachedParameter<Time>) {
    this.attachedTo = parameter
  }

  detached() {
    this.attachedTo = undefined
  }

  setLogical(logical: number | undefined) {
    if (logical === this.logical) return
    this.logical = logical
    this.attachedTo?.requestUpdate()
  }

  paneViews() {
    return this.views
  }
}
