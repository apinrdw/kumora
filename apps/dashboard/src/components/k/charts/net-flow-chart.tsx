import { ChartContainer, ChartTooltip } from "@workspace/ui/components/chart"
import type { ChartConfig } from "@workspace/ui/components/chart"
import { cn } from "@workspace/ui/lib/utils"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import type { FlowPoint } from "@/domain/flow"
import { compactIdr, miliarShort } from "@/lib/format"
import { AXIS_TICK, CHART_COLOR } from "./colors"
import { pointReadout } from "./readout"
import type { ReadoutRow } from "./readout"

export type NetFlowChartProps = {
  data: ReadonlyArray<FlowPoint>
  /** Axis tick text. Default "+Rp318 M". */
  formatTick?: (n: number) => string
  /** Readout value text. Default "+Rp86,2 miliar". */
  formatValue?: (n: number) => string
  /** px. Default 200. */
  height?: number
  /** horizontal bars, labels on the left (broker rankings). Default false. */
  horizontal?: boolean
  className?: string
}

const config = {
  net: { label: "Net flow", color: CHART_COLOR.up },
} satisfies ChartConfig

/** Crosshair readout row: net buy (up color) at or above zero, net sell below. */
export function flowReadoutRow(
  p: FlowPoint,
  formatValue: (n: number) => string
): ReadoutRow {
  const buy = p.net >= 0
  return {
    label: buy ? "Net beli" : "Net jual",
    value: formatValue(p.net),
    swatch: buy ? CHART_COLOR.up : CHART_COLOR.down,
  }
}

/** Diverging bars around a visible zero line: net buy up, net sell down. */
export function NetFlowChart({
  data,
  formatTick = miliarShort,
  formatValue = compactIdr,
  height = 200,
  horizontal = false,
  className,
}: NetFlowChartProps) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d.net)))
  const valueAxis = {
    type: "number" as const,
    domain: [-max, max],
    // Symmetric ticks keep the zero baseline labelled exactly "0".
    ticks: [-max, -max / 2, 0, max / 2, max],
    tickLine: false,
    axisLine: false,
    tick: AXIS_TICK,
    tickFormatter: (n: number) => (n === 0 ? "0" : formatTick(n)),
  }
  const categoryAxis = {
    type: "category" as const,
    dataKey: "label",
    tickLine: false,
    axisLine: false,
    tick: AXIS_TICK,
    interval: 0,
  }
  return (
    <ChartContainer
      config={config}
      className={cn("aspect-auto w-full", className)}
      style={{ height }}
      initialDimension={{ width: 640, height }}
    >
      <BarChart
        data={[...data]}
        layout={horizontal ? "vertical" : "horizontal"}
        margin={{ top: 8, right: 4, bottom: 0, left: 4 }}
      >
        <CartesianGrid
          vertical={horizontal}
          horizontal={!horizontal}
          stroke={CHART_COLOR.grid}
        />
        {horizontal ? (
          <>
            <XAxis {...valueAxis} />
            <YAxis {...categoryAxis} width={48} />
          </>
        ) : (
          <>
            <XAxis {...categoryAxis} minTickGap={8} />
            <YAxis {...valueAxis} orientation="right" width={72} />
          </>
        )}
        {horizontal ? (
          <ReferenceLine x={0} stroke={CHART_COLOR.zero} />
        ) : (
          <ReferenceLine y={0} stroke={CHART_COLOR.zero} />
        )}
        <Bar dataKey="net" isAnimationActive={false} maxBarSize={28}>
          {data.map((d) => (
            <Cell
              key={d.label}
              fill={d.net >= 0 ? CHART_COLOR.up : CHART_COLOR.down}
            />
          ))}
        </Bar>
        <ChartTooltip
          cursor={{ fill: CHART_COLOR.hover, fillOpacity: 0.6 }}
          content={pointReadout(data, (p) => [flowReadoutRow(p, formatValue)])}
        />
      </BarChart>
    </ChartContainer>
  )
}
