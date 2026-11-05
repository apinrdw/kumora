import { ChartContainer, ChartTooltip } from "@workspace/ui/components/chart"
import type { ChartConfig } from "@workspace/ui/components/chart"
import { cn } from "@workspace/ui/lib/utils"
import { useId } from "react"
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts"

import type { PricePoint } from "@/domain/quote"
import { idr, plain, shares } from "@/lib/format"
import { AXIS_TICK, CHART_COLOR, VOLUME_OPACITY } from "./colors"
import { niceScale } from "./scale"
import { pointReadout } from "./readout"
import type { ReadoutRow } from "./readout"

export type PriceChartProps = {
  data: ReadonlyArray<PricePoint>
  /** line: price stroke only · area: stroke over a faint fill. */
  variant?: "line" | "area"
  /** Draws the VWAP overlay when points carry `vwap`. Default true. */
  showVwap?: boolean
  /** Draws volume bars in the bottom quarter when points carry `volume`. Default true. */
  showVolume?: boolean
  /** px. Default 240. */
  height?: number
  className?: string
}

const config = {
  price: { label: "Harga", color: CHART_COLOR.price },
  vwap: { label: "VWAP", color: CHART_COLOR.vwap },
  volume: { label: "Volume", color: CHART_COLOR.volume },
} satisfies ChartConfig

/**
 * Which overlays draw, and the price axis. With volume, the domain extends below
 * the lowest tick so the price sits in the top ~70%, clear of the bars.
 */
export function priceScale(
  data: ReadonlyArray<PricePoint>,
  showVwap: boolean,
  showVolume: boolean
) {
  const hasVwap = showVwap && data.some((d) => d.vwap !== undefined)
  const hasVolume = showVolume && data.some((d) => d.volume !== undefined)
  const maxVolume = Math.max(0, ...data.map((d) => d.volume ?? 0))
  const prices = data.flatMap((d) =>
    hasVwap && d.vwap !== undefined ? [d.price, d.vwap] : [d.price]
  )
  const {
    domain: [lo, hi],
    ticks,
  } = niceScale(Math.min(...prices), Math.max(...prices))
  const domain: [number, number] = [hasVolume ? lo - (hi - lo) * 0.45 : lo, hi]
  return { hasVwap, hasVolume, maxVolume, domain, ticks }
}

/** Crosshair readout rows: price, then VWAP and volume when drawn and present. */
export function priceReadoutRows(
  p: PricePoint,
  hasVwap: boolean,
  hasVolume: boolean
): Array<ReadoutRow> {
  const rows: Array<ReadoutRow> = [
    { label: "Harga", value: idr(p.price), swatch: CHART_COLOR.price },
  ]
  if (hasVwap && p.vwap !== undefined)
    rows.push({ label: "VWAP", value: idr(p.vwap), swatch: CHART_COLOR.vwap })
  if (hasVolume && p.volume !== undefined)
    rows.push({
      label: "Volume",
      value: shares(p.volume),
      swatch: CHART_COLOR.volume,
    })
  return rows
}

/** Intraday or daily price with optional VWAP and volume. Wrap in KChartPanel. */
export function PriceChart({
  data,
  variant = "area",
  showVwap = true,
  showVolume = true,
  height = 240,
  className,
}: PriceChartProps) {
  const gradientId = `price-fill-${useId().replace(/:/g, "")}`
  const { hasVwap, hasVolume, maxVolume, domain, ticks } = priceScale(
    data,
    showVwap,
    showVolume
  )

  return (
    <ChartContainer
      config={config}
      className={cn("aspect-auto w-full", className)}
      style={{ height }}
      initialDimension={{ width: 640, height }}
    >
      <ComposedChart
        data={[...data]}
        margin={{ top: 8, right: 4, bottom: 0, left: 4 }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={CHART_COLOR.price}
              stopOpacity={0.18}
            />
            <stop offset="100%" stopColor={CHART_COLOR.price} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={CHART_COLOR.grid} />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={{ stroke: CHART_COLOR.grid }}
          tick={AXIS_TICK}
          minTickGap={24}
        />
        <YAxis
          yAxisId="price"
          orientation="right"
          domain={domain}
          ticks={ticks}
          tickLine={false}
          axisLine={false}
          tick={AXIS_TICK}
          tickFormatter={(v: number) => plain(v)}
          width={56}
        />
        {hasVolume && (
          // Volume shares the plot but scales to its bottom quarter.
          <>
            <YAxis yAxisId="volume" hide domain={[0, maxVolume * 4]} />
            <Bar
              yAxisId="volume"
              dataKey="volume"
              fill={CHART_COLOR.volume}
              fillOpacity={VOLUME_OPACITY}
              isAnimationActive={false}
            />
          </>
        )}
        {variant === "area" ? (
          <Area
            yAxisId="price"
            dataKey="price"
            type="linear"
            stroke={CHART_COLOR.price}
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
          />
        ) : (
          <Line
            yAxisId="price"
            dataKey="price"
            type="linear"
            stroke={CHART_COLOR.price}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        )}
        {hasVwap && (
          <Line
            yAxisId="price"
            dataKey="vwap"
            type="linear"
            stroke={CHART_COLOR.vwap}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
            isAnimationActive={false}
          />
        )}
        <ChartTooltip
          cursor={{ stroke: CHART_COLOR.zero }}
          content={pointReadout(data, (p) =>
            priceReadoutRows(p, hasVwap, hasVolume)
          )}
        />
      </ComposedChart>
    </ChartContainer>
  )
}
