import { Card } from "@workspace/ui/components/card"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

import { CHART_COLOR } from "./charts/colors"
import type { ChartColor } from "./charts/colors"
import { KStateBody } from "./empty-state"
import type { KDataState } from "./empty-state"
import { KSkeleton } from "./skeleton"
import { KSourceLine } from "./source-line"
import { KStatusPill } from "./status-pill"
import type { Freshness } from "@/domain/freshness"
import { KTabs } from "./tabs"

export type LegendItem = {
  label: string
  color: ChartColor
  /** bar: filled swatch · line: solid stroke (default) · dash: dashed stroke */
  mark?: "bar" | "line" | "dash"
}

/** Legend for CandlestickChart: up and down candles, volume bars, VWAP line. */
export const CANDLE_LEGEND = [
  { label: "Harga naik", color: "up", mark: "bar" },
  { label: "Harga turun", color: "down", mark: "bar" },
  { label: "Volume", color: "volume", mark: "bar" },
  { label: "VWAP", color: "vwap", mark: "dash" },
] as const satisfies ReadonlyArray<LegendItem>

/** Legend for NetFlowChart valued in rupiah. */
export const NET_FLOW_LEGEND = [
  { label: "Net beli (nilai)", color: "up", mark: "bar" },
  { label: "Net jual (nilai)", color: "down", mark: "bar" },
] as const satisfies ReadonlyArray<LegendItem>

export type KChartPanelProps<T extends string = string> = {
  title: string
  freshness: Freshness
  /** ISO datetime. */
  asOf?: string
  /** Required: where the data comes from. */
  source: string
  /** Required: e.g. "Rp per saham". Timezone WIB is appended. */
  unit: string
  /** Required: accessible text summary of what the chart shows. */
  summary: string
  legend?: ReadonlyArray<LegendItem>
  timeframes?: ReadonlyArray<T>
  timeframe?: T
  onTimeframeChange?: (timeframe: T) => void
  /** Extra header controls, right-aligned. */
  actions?: ReactNode
  /** Non-ready states replace the body. */
  state?: KDataState
  className?: string
  /** The chart itself (e.g. PriceChart, CandlestickChart, NetFlowChart). */
  children: ReactNode
}

function HeaderControls<T extends string>({
  timeframes,
  timeframe,
  onTimeframeChange,
  actions,
}: Pick<
  KChartPanelProps<T>,
  "timeframes" | "timeframe" | "onTimeframeChange" | "actions"
>) {
  if (!timeframes && !actions) return null
  return (
    <div className="flex items-center gap-2">
      {timeframes && (
        <KTabs
          variant="segmented"
          compact
          label="Interval"
          tabs={timeframes.map((t) => ({ value: t, label: t }))}
          value={timeframe}
          onValueChange={onTimeframeChange}
        />
      )}
      {actions}
    </div>
  )
}

function Legend({ items }: { items: ReadonlyArray<LegendItem> }) {
  if (items.length === 0) return null
  return (
    <ul
      aria-label="Legenda"
      className="text-secondary-text flex flex-wrap gap-3 text-xs leading-[18px]"
    >
      {items.map((l) => (
        <li key={l.label} className="inline-flex items-center gap-1">
          <LegendMark color={l.color} mark={l.mark ?? "line"} />
          {l.label}
        </li>
      ))}
    </ul>
  )
}

function ChartBody({
  state,
  stale,
  children,
}: {
  state: KDataState
  stale: boolean
  children: ReactNode
}) {
  return (
    <div className={cn("relative min-h-[120px]", stale && "opacity-85")}>
      {state.status === "ready" ? (
        children
      ) : (
        <KStateBody
          state={state}
          skeleton={<KSkeleton kind="chart" height={160} />}
        />
      )}
    </div>
  )
}

export function KChartPanel<T extends string = string>({
  title,
  freshness,
  asOf,
  source,
  unit,
  summary,
  legend = [],
  state = { status: "ready" },
  className,
  children,
  ...controls
}: KChartPanelProps<T>) {
  const stale = freshness === "stale"
  return (
    <Card
      role="region"
      aria-label={title}
      className={cn(
        "bg-surface w-full min-w-0 gap-3 overflow-visible rounded-lg border border-border p-5 text-foreground ring-0",
        stale && "border-warning",
        className
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base leading-6 font-[650]">{title}</h3>
          <KStatusPill status={freshness} asOf={asOf} />
        </div>
        <HeaderControls {...controls} />
      </div>
      <p className="sr-only">{summary}</p>
      <ChartBody state={state} stale={stale}>
        {children}
      </ChartBody>
      <div className="flex flex-wrap justify-between gap-3">
        <Legend items={legend} />
        <KSourceLine source={source} asOf={asOf} />
      </div>
      <div className="text-xs leading-[18px] text-muted-foreground">
        Satuan: {unit} · Zona waktu WIB
      </div>
    </Card>
  )
}

function LegendMark({
  color,
  mark,
}: {
  color: ChartColor
  mark: NonNullable<LegendItem["mark"]>
}) {
  const c = CHART_COLOR[color]
  if (mark === "bar") {
    return (
      <i
        aria-hidden
        className="inline-block h-2.5 w-2 rounded-[1px]"
        style={{ background: c }}
      />
    )
  }
  return (
    <i
      aria-hidden
      className="inline-block h-[3px] w-3 rounded-[2px]"
      style={{
        background:
          mark === "dash"
            ? `repeating-linear-gradient(90deg, ${c} 0 3px, transparent 3px 5px)`
            : c,
      }}
    />
  )
}
