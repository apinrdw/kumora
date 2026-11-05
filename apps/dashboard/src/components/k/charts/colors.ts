/** The only colors a chart may use; every value is a KUMORA token. */
export const CHART_COLOR = {
  /** Price line: neutral light, never a direction color. */
  price: "var(--text-secondary)",
  up: "var(--semantic-up)",
  down: "var(--semantic-down)",
  vwap: "var(--chart-vwap)",
  /** Draw at opacity 0.65. */
  volume: "var(--chart-volume)",
  grid: "var(--chart-grid)",
  axis: "var(--text-muted)",
  zero: "var(--border-strong)",
  /** Crosshair band behind the hovered point. */
  hover: "var(--bg-elevated)",
  accent: "var(--accent-primary)",
  warning: "var(--semantic-warning)",
  info: "var(--semantic-info)",
  neutral: "var(--semantic-neutral)",
} as const

export type ChartColor = keyof typeof CHART_COLOR

export const VOLUME_OPACITY = 0.65

/** Tick label style: micro, muted, tabular figures. */
export const AXIS_TICK = {
  fill: CHART_COLOR.axis,
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  fontVariantNumeric: "tabular-nums",
} as const
