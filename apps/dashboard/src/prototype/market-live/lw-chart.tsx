// PROTOTYPE, throwaway: Lightweight Charts 1-minute candles + volume, mounted client-only.
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
} from "lightweight-charts"
import { useEffect, useRef } from "react"

import { FEED, history } from "./fake-feed"
import type { Bar } from "./fake-feed"

const wibTime = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Jakarta",
})
const wib = (t: unknown) => wibTime.format(new Date((t as number) * 1000))

export function LwChart({
  code,
  className,
}: {
  code: string
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    FEED.focus = code
    {
      {
        if (!host.current) return
        const css = getComputedStyle(document.documentElement)
        const v = (name: string) => css.getPropertyValue(name).trim()
        const up = v("--semantic-up")
        const down = v("--semantic-down")
        const chart = createChart(host.current, {
          autoSize: true,
          layout: {
            background: { color: "transparent" },
            textColor: v("--text-muted"),
            fontFamily: "Manrope Variable, Arial, sans-serif",
            fontSize: 11,
          },
          grid: {
            vertLines: { color: v("--chart-grid") },
            horzLines: { color: v("--chart-grid") },
          },
          rightPriceScale: { borderColor: v("--border-subtle") },
          timeScale: {
            borderColor: v("--border-subtle"),
            timeVisible: true,
            secondsVisible: false,
            rightOffset: 4,
            tickMarkFormatter: wib,
          },
          localization: { locale: "id-ID", timeFormatter: wib },
          crosshair: { mode: 1 },
        })
        const candles = chart.addSeries(CandlestickSeries, {
          upColor: up,
          downColor: down,
          wickUpColor: up,
          wickDownColor: down,
          borderVisible: false,
        })
        candles
          .priceScale()
          .applyOptions({ scaleMargins: { top: 0.08, bottom: 0.26 } })
        const volume = chart.addSeries(HistogramSeries, {
          priceScaleId: "",
          priceFormat: { type: "volume" },
          lastValueVisible: false,
          priceLineVisible: false,
        })
        volume
          .priceScale()
          .applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })

        const vol = (b: Bar) => ({
          time: b.time as never,
          value: b.lots,
          color: (b.close >= b.open ? up : down) + "66",
        })
        const bars = history(code)
        candles.setData(bars.map((b) => ({ ...b, time: b.time as never })))
        volume.setData(bars.map(vol))
        let last: Bar = { ...bars.at(-1)! }

        const unsubscribe = FEED.subscribe((t) => {
          if (t.code !== code) return
          const minute = Math.floor(t.time / 60) * 60
          last =
            minute > last.time
              ? {
                  time: minute,
                  open: t.price,
                  high: t.price,
                  low: t.price,
                  close: t.price,
                  lots: t.lots,
                }
              : {
                  ...last,
                  high: Math.max(last.high, t.price),
                  low: Math.min(last.low, t.price),
                  close: t.price,
                  lots: last.lots + t.lots,
                }
          candles.update({ ...last, time: last.time as never })
          volume.update(vol(last))
        })
        return () => {
          unsubscribe()
          chart.remove()
        }
      }
    }
  }, [code])

  return <div ref={host} className={className} />
}

/** Required by the Lightweight Charts licence (NOTICE). */
export function LwNotice() {
  return (
    <p className="text-[10px] text-muted-foreground">
      Grafik oleh{" "}
      <a
        href="https://www.tradingview.com/"
        className="underline"
        target="_blank"
        rel="noreferrer"
      >
        TradingView Lightweight Charts™
      </a>
      . Copyright (c) 2025 TradingView, Inc.
    </p>
  )
}
