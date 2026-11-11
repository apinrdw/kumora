import { cn } from "@workspace/ui/lib/utils"
import { kFocus } from "../styles"
import { Effect } from "effect"
import { useState } from "react"

import type { Candle } from "@/domain/quote"
import { idr, plain, shares } from "@/lib/format"
import { AXIS_TICK, CHART_COLOR, VOLUME_OPACITY } from "./colors"
import { niceScale } from "./scale"

export type CandlestickChartProps = {
  data: ReadonlyArray<Candle>
  /** Default true when candles carry `vwap`. */
  showVwap?: boolean
  /** Default true when candles carry `v`. */
  showVolume?: boolean
  /** Label every nth candle on the x-axis. Default: about five labels. */
  labelEvery?: number
  className?: string
}

// Fixed viewBox, scaled to the container width; SSR and client render the same geometry.
const W = 640
const PL = 8
const PR = 56
const PRICE_H = 150
const VOL_TOP = 162
const VOL_H = 48
const H = 222

/**
 * OHLC candles (up = semantic-up, down = semantic-down, wick matches body),
 * volume histogram and VWAP. Recharts has no candle mark, so this is plain SVG.
 * The readout shows the latest candle; hover, or focus and use ←/→, to read others.
 */
export function CandlestickChart({
  data,
  showVwap = true,
  showVolume = true,
  labelEvery,
  className,
}: CandlestickChartProps) {
  const [active, setActive] = useState<number | null>(null)
  const n = data.length
  if (n === 0) return null

  const withVwap = showVwap && data.some((d) => d.vwap !== undefined)
  const withVolume = showVolume && data.some((d) => d.v !== undefined)
  const prices = data.flatMap((d) =>
    withVwap && d.vwap !== undefined ? [d.h, d.l, d.vwap] : [d.h, d.l]
  )
  const {
    domain: [lo, hi],
    ticks,
  } = Effect.runSync(niceScale(Math.min(...prices), Math.max(...prices)))
  const vmax = Math.max(1, ...data.map((d) => d.v ?? 0))
  const cw = (W - PL - PR) / n
  const bw = Math.max(2, cw * 0.6)
  const y = (p: number) => 8 + (PRICE_H - 8) * (1 - (p - lo) / (hi - lo))
  const x = (i: number) => PL + i * cw + cw / 2
  const every = labelEvery ?? Math.max(1, Math.ceil(n / 5))
  const vwapPath = data
    .map((d, i) => {
      if (d.vwap === undefined) return ""
      const cmd = i === 0 || data[i - 1]?.vwap === undefined ? "M" : "L"
      return `${cmd}${x(i).toFixed(1)} ${y(d.vwap).toFixed(1)}`
    })
    .join(" ")

  const focus = data[active ?? n - 1]

  return (
    <div className={className}>
      <div
        aria-live="polite"
        className="num text-secondary-text mb-1 flex min-h-[18px] flex-wrap gap-x-3 text-xs leading-[18px]"
      >
        <span className="text-foreground">{focus.label}</span>
        <span>O {Effect.runSync(idr(focus.o))}</span>
        <span>H {Effect.runSync(idr(focus.h))}</span>
        <span>L {Effect.runSync(idr(focus.l))}</span>
        <span className={focus.c >= focus.o ? "text-up" : "text-down"}>
          C {Effect.runSync(idr(focus.c))}
        </span>
        {focus.v !== undefined && (
          <span>Vol {Effect.runSync(shares(focus.v))}</span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={cn("block h-auto w-full rounded-xs", kFocus)}
        tabIndex={0}
        role="slider"
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={active ?? n - 1}
        aria-valuetext={focus.label}
        aria-label="Grafik candlestick. Gunakan panah kiri dan kanan untuk membaca tiap sesi."
        onMouseLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
          e.preventDefault()
          const step = e.key === "ArrowRight" ? 1 : -1
          setActive((i) =>
            i === null
              ? step > 0
                ? 0
                : n - 1
              : Math.min(n - 1, Math.max(0, i + step))
          )
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PL}
              x2={W - PR}
              y1={y(t)}
              y2={y(t)}
              stroke={CHART_COLOR.grid}
            />
            <text x={W - PR + 6} y={y(t) + 4} style={AXIS_TICK}>
              {Effect.runSync(plain(Math.round(t)))}
            </text>
          </g>
        ))}
        {active !== null && (
          <rect
            x={x(active) - cw / 2}
            y={0}
            width={cw}
            height={VOL_TOP + VOL_H}
            fill={CHART_COLOR.hover}
            opacity={0.6}
          />
        )}
        {data.map((d, i) => {
          const color = d.c >= d.o ? CHART_COLOR.up : CHART_COLOR.down
          const vh = d.v === undefined ? 0 : VOL_H * (d.v / vmax)
          return (
            <g key={i}>
              <line
                x1={x(i)}
                x2={x(i)}
                y1={y(d.h)}
                y2={y(d.l)}
                stroke={color}
              />
              <rect
                x={x(i) - bw / 2}
                y={y(Math.max(d.o, d.c))}
                width={bw}
                height={Math.max(1, Math.abs(y(d.o) - y(d.c)))}
                fill={color}
              />
              {withVolume && vh > 0 && (
                <rect
                  x={x(i) - bw / 2}
                  y={VOL_TOP + VOL_H - vh}
                  width={bw}
                  height={vh}
                  fill={CHART_COLOR.volume}
                  opacity={active === i ? 1 : VOLUME_OPACITY}
                />
              )}
              {i % every === 0 && (
                <text x={x(i)} y={H - 2} textAnchor="middle" style={AXIS_TICK}>
                  {d.label}
                </text>
              )}
              <rect
                x={x(i) - cw / 2}
                y={0}
                width={cw}
                height={VOL_TOP + VOL_H}
                fill="transparent"
                onMouseEnter={() => setActive(i)}
              />
            </g>
          )
        })}
        {withVwap && (
          <path
            d={vwapPath}
            fill="none"
            stroke={CHART_COLOR.vwap}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
        )}
        {withVolume && (
          <>
            <line
              x1={PL}
              x2={W - PR}
              y1={VOL_TOP + VOL_H}
              y2={VOL_TOP + VOL_H}
              stroke={CHART_COLOR.grid}
            />
            <text x={W - PR + 6} y={VOL_TOP + VOL_H} style={AXIS_TICK}>
              Vol
            </text>
          </>
        )}
      </svg>
    </div>
  )
}
