// PROTOTYPE, throwaway: three ways to browse a past trading day on Market Live, on a seeded fake
// of what each day's Durable Object keeps (merged tape, candles built from it, order book frames).
// I: static close + day stepper. J: replay with a transport bar. K: day strip + chart time cursor.
import { cn } from "@workspace/ui/lib/utils"
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts"
import type {
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  Time,
} from "lightweight-charts"
import { useEffect, useMemo, useRef, useState } from "react"

import { Delta } from "@/components/k"
import { plain } from "@/lib/format"
import { STOCKS, hms, seeded, tick } from "./fake-feed"
import type { Bar, Trade } from "./fake-feed"
import { LwNotice } from "./lw-chart"
import { LadderView, limits } from "./order-book"
import type { Book, Level } from "./order-book"
import { CodeSearch, TapeTable, compact, useWatchlist } from "./variants"
import type { VariantProps } from "./variants"

// ---------- the recorded days ----------

const WIB = 7 * 3600

/** UTC seconds of `hh:mm` WIB on `day`. */
function at(day: string, hh: number, mm: number): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d, hh, mm) / 1000 - WIB
}

function weekday(day: string): number {
  return new Date(at(day, 12, 0) * 1000).getUTCDay()
}

/** The last 20 weekdays before today: every day the relay kept. Holidays are ignored here. */
const KEPT_DAYS: ReadonlyArray<string> = (() => {
  const out: Array<string> = []
  const d = new Date()
  while (out.length < 20) {
    d.setUTCDate(d.getUTCDate() - 1)
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue
    out.push(d.toISOString().slice(0, 10))
  }
  return out
})()

/** Regular-market sessions in WIB; Friday's lunch break is longer. */
function sessions(day: string): ReadonlyArray<readonly [number, number]> {
  const fri = weekday(day) === 5
  return [
    [at(day, 9, 0), fri ? at(day, 11, 30) : at(day, 12, 0)],
    [fri ? at(day, 14, 0) : at(day, 13, 30), at(day, 15, 50)],
  ]
}

function minutes(day: string): ReadonlyArray<number> {
  return sessions(day).flatMap(([a, b]) =>
    Array.from({ length: (b - a) / 60 }, (_, i) => a + i * 60)
  )
}

const fullDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})
const shortDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
})
const dayLabel = (day: string) => fullDate.format(new Date(`${day}T00:00:00Z`))
const dayShort = (day: string) => shortDate.format(new Date(`${day}T00:00:00Z`))
const hm = (t: number) => hms(t).slice(0, 5)

function prevClose(day: string, code: string): number {
  const base = STOCKS.find((s) => s.code === code)!.prevClose
  const p = base * (1 + (seeded(day + code + "pc")() - 0.5) * 0.08)
  return Math.round(p / tick(p)) * tick(p)
}

const barCache = new Map<string, ReadonlyArray<Bar>>()
function dayBars(day: string, code: string): ReadonlyArray<Bar> {
  const key = day + code
  const hit = barCache.get(key)
  if (hit) return hit
  const rand = seeded(key)
  const anchor = prevClose(day, code)
  const drift = (rand() - 0.5) * 0.3
  let price = anchor
  const bars = minutes(day).map((time) => {
    const open = price
    let high = open
    let low = open
    for (let i = 0; i < 6; i++) {
      const t = tick(price)
      const r = rand() + drift * 0.1
      price = Math.max(t, price + (r < 0.42 ? -t : r > 0.58 ? t : 0))
      high = Math.max(high, price)
      low = Math.min(low, price)
    }
    return {
      time,
      open,
      high,
      low,
      close: price,
      lots: Math.round(2_000 + rand() * 14_000),
    }
  })
  barCache.set(key, bars)
  return bars
}

const barsUpTo = (day: string, code: string, t: number) =>
  dayBars(day, code).filter((b) => b.time <= t)

function priceAt(day: string, code: string, t: number): number {
  return barsUpTo(day, code, t).at(-1)?.close ?? prevClose(day, code)
}

function statsAt(day: string, code: string, t: number) {
  const bars = barsUpTo(day, code, t)
  return {
    value: bars.reduce((s, b) => s + b.lots * b.close * 100, 0),
    lots: bars.reduce((s, b) => s + b.lots, 0),
    freq: bars.reduce((s, b) => s + Math.round(b.lots / 60), 0),
  }
}

/** The whole-market tape of one minute, newest first. A real minute holds ~4–15k trades; 60 here. */
const minuteCache = new Map<string, ReadonlyArray<Trade>>()
function tapeOfMinute(day: string, minute: number): ReadonlyArray<Trade> {
  const key = `${day}:${minute}`
  const hit = minuteCache.get(key)
  if (hit) return hit
  const rand = seeded(key)
  const idx = minutes(day).indexOf(minute)
  const out: Array<Trade> = Array.from({ length: 60 }, (_, i) => {
    const code = STOCKS[Math.floor(rand() * STOCKS.length)]!.code
    const bar = dayBars(day, code).find((b) => b.time === minute)
    const lo = bar?.low ?? prevClose(day, code)
    const hi = bar?.high ?? lo
    const t = tick(lo)
    const price = lo + Math.floor(rand() * ((hi - lo) / t + 1)) * t
    return {
      tradeNumber: 1 + idx * 60 + i,
      time: minute + i,
      code,
      price,
      lots:
        rand() < 0.0125
          ? Math.ceil(1_000 + rand() * 20_000)
          : Math.ceil(rand() ** 4 * 300),
      side: rand() < 0.5 ? "B" : "S",
      feeds: rand() < 0.04 ? ["stockbit"] : ["stockbit", "ajaib"],
    }
  })
  out.reverse()
  minuteCache.set(key, out)
  return out
}

/** The newest `n` trades at or before `t`, newest first. */
function tapeUpTo(day: string, t: number, n = 200): ReadonlyArray<Trade> {
  const ms = minutes(day).filter((m) => m <= t)
  const out: Array<Trade> = []
  for (let i = ms.length - 1; i >= 0 && out.length < n; i--)
    out.push(...tapeOfMinute(day, ms[i]!).filter((x) => x.time <= t))
  return out.slice(0, n)
}

/** The stored order book frame in force at `t` (frames ~2/s; one per 5 s here). */
function bookAt(day: string, code: string, t: number): Book {
  const frame = Math.floor(Math.min(t, at(day, 15, 49) + 59) / 5) * 5
  const rand = seeded(`${day}${code}${frame}`)
  const prev = prevClose(day, code)
  const last = priceAt(day, code, t)
  const { ara, arb } = limits(prev)
  const side = (dir: 1 | -1): Array<Level> => {
    const out: Array<Level> = []
    for (
      let p = dir === 1 ? last + tick(last) : last;
      dir === 1 ? p <= ara : p >= arb;
      p += dir * tick(p)
    ) {
      const base = out.length < 3 ? 4_000 : out.length < 10 ? 1_500 : 300
      out.push({
        price: p,
        lots: Math.ceil(base * (0.3 + rand() * 1.4)),
        orders: Math.ceil(5 + rand() * 60),
      })
      if (out.length >= 40) break
    }
    return out
  }
  return {
    code,
    bid: side(-1),
    offer: side(1),
    source: "recorded",
    asOf: frame * 1000,
    ara,
    arb,
    last,
    prevClose: prev,
  }
}

const close = (day: string) => at(day, 15, 49) + 59
const open = (day: string) => at(day, 9, 0)

// ---------- shared pieces ----------

/** A static candle chart of `bars`; `cursor` marks a minute, `onPick` reports a clicked minute. */
function PastChart({
  bars,
  cursor,
  onPick,
  className,
}: {
  bars: ReadonlyArray<Bar>
  cursor?: number
  onPick?: (minute: number) => void
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const api = useRef<{
    chart: IChartApi
    candles: ISeriesApi<"Candlestick">
    volume: ISeriesApi<"Histogram">
    markers: ISeriesMarkersPluginApi<Time>
    up: string
    down: string
  } | null>(null)
  const pick = useRef(onPick)
  useEffect(() => {
    pick.current = onPick
  })

  useEffect(() => {
    if (!host.current) return
    const css = getComputedStyle(document.documentElement)
    const v = (name: string) => css.getPropertyValue(name).trim()
    const up = v("--semantic-up")
    const down = v("--semantic-down")
    const fmt = (t: unknown) => hm(t as number)
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
        rightOffset: 4,
        tickMarkFormatter: fmt,
      },
      localization: { locale: "id-ID", timeFormatter: fmt },
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
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    const markers = createSeriesMarkers(candles, [])
    chart.subscribeClick((p) => {
      if (p.time !== undefined) pick.current?.(p.time as number)
    })
    api.current = { chart, candles, volume, markers, up, down }
    return () => {
      api.current = null
      chart.remove()
    }
  }, [])

  useEffect(() => {
    const a = api.current
    if (!a) return
    a.candles.setData(bars.map((b) => ({ ...b, time: b.time as Time })))
    a.volume.setData(
      bars.map((b) => ({
        time: b.time as Time,
        value: b.lots,
        color: (b.close >= b.open ? a.up : a.down) + "66",
      }))
    )
  }, [bars])

  useEffect(() => {
    api.current?.markers.setMarkers(
      cursor === undefined
        ? []
        : [
            {
              time: (Math.floor(cursor / 60) * 60) as Time,
              position: "aboveBar",
              shape: "arrowDown",
              color: "#888",
              text: hm(cursor),
            },
          ]
    )
  }, [cursor])

  return <div ref={host} className={className} />
}

/** Replaces the live feed pills: the day is recorded, so freshness is end-of-day. */
function RecordedPill({ label }: { label: string }) {
  return (
    <span
      title="A past trading day, as the relay recorded it. Read-only."
      className="bg-elevated text-info inline-flex h-[22px] items-center gap-1 rounded-full border border-border px-2 text-[11px] font-medium tracking-[0.04em]"
    >
      <i aria-hidden className="size-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
}

function Quote({ day, code, t }: { day: string; code: string; t: number }) {
  const last = priceAt(day, code, t)
  const prev = prevClose(day, code)
  return (
    <div className="flex items-baseline gap-2">
      <b className="text-xl">{code}</b>
      <span className="num text-xl font-semibold">{plain(last)}</span>
      <Delta value={((last - prev) / prev) * 100} />
    </div>
  )
}

function DaySelect({
  day,
  onDay,
}: {
  day: string
  onDay: (d: string) => void
}) {
  return (
    <select
      value={day}
      onChange={(e) => onDay(e.target.value)}
      className="bg-surface h-9 rounded-md border border-input px-2 text-sm"
      aria-label="Trading day"
    >
      <option value="live">Today · live</option>
      {KEPT_DAYS.map((d) => (
        <option key={d} value={d}>
          {dayLabel(d)}
        </option>
      ))}
    </select>
  )
}

function DayStepper({
  day,
  onDay,
}: {
  day: string
  onDay: (d: string) => void
}) {
  const i = KEPT_DAYS.indexOf(day)
  const older = KEPT_DAYS[i + 1]
  const newer = i > 0 ? KEPT_DAYS[i - 1] : "live"
  const btn =
    "bg-surface hover:bg-elevated h-9 rounded-md border border-input px-2.5 text-sm disabled:opacity-40"
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={btn}
        disabled={!older}
        onClick={() => older && onDay(older)}
        aria-label="Previous trading day"
        title="Previous trading day ([)"
      >
        ‹
      </button>
      <DaySelect day={day} onDay={onDay} />
      <button
        type="button"
        className={btn}
        onClick={() => onDay(newer!)}
        aria-label="Next trading day"
        title="Next trading day (])"
      >
        ›
      </button>
    </div>
  )
}

function PastWatchlist({
  day,
  t,
  code,
  onPick,
  title,
  className,
}: {
  day: string
  t: number
  code: string
  onPick: (c: string) => void
  title: string
  className?: string
}) {
  const [list] = useWatchlist()
  return (
    <section
      className={cn(
        "bg-surface flex min-h-0 flex-col rounded-lg border border-border",
        className
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="text-sm font-semibold">Watchlist</h2>
        <span className="num ml-auto text-[11px] text-muted-foreground">
          {title}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="num w-full text-[12px]">
          <thead className="bg-surface sticky top-0 text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
            <tr className="h-7 text-right">
              <th className="pl-3 text-left font-medium">Code</th>
              <th className="font-medium">Last</th>
              <th className="font-medium">Chg</th>
              <th className="font-medium">Value</th>
              <th className="font-medium">Vol (lot)</th>
              <th className="pr-3 font-medium">Freq</th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => {
              const last = priceAt(day, c, t)
              const prev = prevClose(day, c)
              const st = statsAt(day, c, t)
              return (
                <tr
                  key={c}
                  className={cn(
                    "hover:bg-elevated h-8 text-right",
                    c === code &&
                      "bg-selected shadow-[inset_2px_0_0_var(--accent-primary)]"
                  )}
                >
                  <td className="pl-3 text-left">
                    <button
                      type="button"
                      onClick={() => onPick(c)}
                      className="font-bold hover:underline"
                    >
                      {c}
                    </button>
                  </td>
                  <td>{plain(last)}</td>
                  <td>
                    <Delta
                      value={((last - prev) / prev) * 100}
                      className="justify-end text-[11px] [&_svg]:hidden"
                    />
                  </td>
                  <td className="text-muted-foreground">{compact(st.value)}</td>
                  <td className="text-muted-foreground">{compact(st.lots)}</td>
                  <td className="pr-3 text-muted-foreground">
                    {compact(st.freq)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function PastTape({
  code,
  trades,
  onCode,
  title,
  tools,
  footer,
  className,
}: {
  code: string
  trades: ReadonlyArray<Trade>
  onCode: (c: string) => void
  title: string
  tools?: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        "bg-surface flex min-h-0 flex-col rounded-lg border border-border",
        className
      )}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="ml-auto flex items-center gap-2">{tools}</span>
      </header>
      <div className="h-[420px] min-h-0 flex-1 overflow-y-auto lg:h-auto">
        <TapeTable code={code} trades={trades} wide onPick={onCode} />
        {footer}
      </div>
    </section>
  )
}

/** `[` and `]` step a day; `live` returns to today. */
function useDayKeys(day: string, onDay: (d: string) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]"
        )
      )
        return
      const i = KEPT_DAYS.indexOf(day)
      if (e.key === "[" && KEPT_DAYS[i + 1]) onDay(KEPT_DAYS[i + 1]!)
      if (e.key === "]") onDay(i > 0 ? KEPT_DAYS[i - 1]! : "live")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [day, onDay])
}

type PastProps = VariantProps & { day: string; onDay: (d: string) => void }

function usePastProps(props: VariantProps): PastProps {
  const day =
    props.day && KEPT_DAYS.includes(props.day) ? props.day : KEPT_DAYS[0]!
  const onDay = props.onDay ?? (() => {})
  useDayKeys(day, onDay)
  return { ...props, day, onDay }
}

const GRID =
  "grid gap-3 lg:h-[calc(100svh-7.5rem)] lg:grid-cols-[minmax(0,1fr)_400px]"
const CARD = "bg-surface flex min-h-0 flex-col rounded-lg border border-border"

// ---------- I: static close, day stepper in the chart header ----------

export function VariantI(props: VariantProps) {
  const p = usePastProps(props)
  return <VariantIDay key={p.day} {...p} />
}

function VariantIDay({ code, onCode, day, onDay }: PastProps) {
  const end = close(day)
  const bars = useMemo(() => dayBars(day, code), [day, code])
  // The tape opens at the close; "Jump to" moves its newest row, "Load earlier" pages back.
  const [jump, setJump] = useState("")
  const [pages, setPages] = useState(1)
  const [hh, mm] = jump.split(":").map(Number)
  const tEnd =
    jump && hh !== undefined && mm !== undefined && !Number.isNaN(mm)
      ? Math.min(end, at(day, hh, mm) + 59)
      : end
  const trades = useMemo(
    () => tapeUpTo(day, tEnd, 200 * pages),
    [day, tEnd, pages]
  )
  return (
    <div className={GRID}>
      <section className={CARD}>
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border p-3">
          <CodeSearch onPick={onCode} className="w-48" />
          <Quote day={day} code={code} t={end} />
          <span className="text-xs text-muted-foreground">at close</span>
          <span className="ml-auto flex items-center gap-2">
            <RecordedPill label="CLOSED DAY" />
            <DayStepper day={day} onDay={onDay} />
          </span>
        </header>
        <PastChart bars={bars} className="h-[420px] min-h-0 flex-1 p-2" />
        <footer className="border-t border-border px-3 py-1.5">
          <LwNotice />
        </footer>
      </section>
      <div className="flex min-h-0 flex-col gap-3">
        <PastWatchlist
          day={day}
          t={end}
          code={code}
          onPick={onCode}
          title={`${dayShort(day)} · close`}
          className="max-h-60 shrink-0 lg:max-h-[26%]"
        />
        <LadderView
          key={code}
          book={bookAt(day, code, end)}
          className="shrink-0"
        />
        <PastTape
          code={code}
          trades={trades}
          onCode={onCode}
          title="Running trades · whole market"
          className="min-h-40 flex-1"
          tools={
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              Jump to
              <input
                type="time"
                value={jump}
                min="09:00"
                max="15:50"
                onChange={(e) => {
                  setJump(e.target.value)
                  setPages(1)
                }}
                className="bg-surface h-7 rounded border border-input px-1 text-xs"
              />
            </label>
          }
          footer={
            <button
              type="button"
              onClick={() => setPages((p) => p + 1)}
              className="hover:bg-elevated w-full border-t border-border py-2 text-xs text-muted-foreground"
            >
              Load earlier trades
            </button>
          }
        />
      </div>
    </div>
  )
}

// ---------- J: replay, transport bar under the chart drives every panel ----------

const SPEEDS = [1, 10, 60, 300] as const

export function VariantJ(props: VariantProps) {
  const p = usePastProps(props)
  return <VariantJDay key={p.day} {...p} />
}

function VariantJDay({ code, onCode, day, onDay }: PastProps) {
  const [t, setT] = useState(() => open(day) + 30 * 60)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(60)
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      setT((x) => {
        let n = x + speed / 4
        // Skip the lunch break and stop at the close.
        const [s1, s2] = sessions(day)
        if (n > s1![1] && n < s2![0]) n = s2![0]
        if (n >= close(day)) {
          setPlaying(false)
          return close(day)
        }
        return n
      })
    }, 250)
    return () => clearInterval(id)
  }, [playing, speed, day])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          "input,textarea,select,[contenteditable]"
        )
      )
        return
      if (e.key === " ") {
        e.preventDefault()
        setPlaying((p) => !p)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const minute = Math.floor(t / 60) * 60
  const bars = useMemo(() => barsUpTo(day, code, minute), [day, code, minute])
  const tSec = Math.floor(t)
  const trades = useMemo(() => tapeUpTo(day, tSec), [day, tSec])
  const from = at(day, 8, 45)
  const to = at(day, 16, 15)
  const pct = (x: number) => ((x - from) / (to - from)) * 100
  return (
    <div className={GRID}>
      <section className={CARD}>
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border p-3">
          <CodeSearch onPick={onCode} className="w-48" />
          <Quote day={day} code={code} t={t} />
          <span className="ml-auto flex items-center gap-2">
            <RecordedPill label="REPLAY" />
            <DaySelect day={day} onDay={onDay} />
          </span>
        </header>
        <PastChart bars={bars} className="h-[380px] min-h-0 flex-1 p-2" />
        <div className="flex items-center gap-3 border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="h-8 w-16 rounded-md bg-primary text-sm font-semibold text-primary-foreground"
            title="Play / pause (Space)"
          >
            {playing ? "Pause" : "Play"}
          </button>
          <div className="flex overflow-hidden rounded-md border border-border text-xs">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                className={cn(
                  "px-2 py-1",
                  s === speed
                    ? "bg-selected font-bold"
                    : "text-muted-foreground"
                )}
              >
                {s}×
              </button>
            ))}
          </div>
          <div className="relative flex-1">
            {/* Session bands behind the scrubber. */}
            <div className="pointer-events-none absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded bg-border/40">
              {sessions(day).map(([a, b]) => (
                <i
                  key={a}
                  className="bg-info/40 absolute inset-y-0"
                  style={{ left: `${pct(a)}%`, width: `${pct(b) - pct(a)}%` }}
                />
              ))}
            </div>
            <input
              type="range"
              min={from}
              max={to}
              step={1}
              value={t}
              onChange={(e) => setT(Number(e.target.value))}
              className="relative w-full accent-[var(--accent-primary)]"
              aria-label="Replay time"
            />
            <div className="num flex justify-between text-[10px] text-muted-foreground">
              <span>08:45</span>
              <span>12:00</span>
              <span>16:15</span>
            </div>
          </div>
          <span className="num w-20 text-right text-sm font-semibold">
            {hms(t)}
          </span>
        </div>
        <footer className="border-t border-border px-3 py-1.5">
          <LwNotice />
        </footer>
      </section>
      <div className="flex min-h-0 flex-col gap-3">
        <PastWatchlist
          day={day}
          t={t}
          code={code}
          onPick={onCode}
          title={`${dayShort(day)} · ${hms(t)}`}
          className="max-h-60 shrink-0 lg:max-h-[26%]"
        />
        <LadderView
          key={code}
          book={bookAt(day, code, t)}
          className="shrink-0"
        />
        <PastTape
          code={code}
          trades={trades}
          onCode={onCode}
          title="Running trades · whole market"
          className="min-h-40 flex-1"
          tools={
            <span className="num text-[11px] text-muted-foreground">
              up to {hms(t)}
            </span>
          }
        />
      </div>
    </div>
  )
}

// ---------- K: day strip across the top, click a candle to pin the minute ----------

export function VariantK(props: VariantProps) {
  const p = usePastProps(props)
  return <VariantKDay key={p.day} {...p} />
}

function VariantKDay({ code, onCode, day, onDay }: PastProps) {
  const all = minutes(day)
  const [pinned, setPinned] = useState(() => all.at(-1)!)
  const bars = useMemo(() => dayBars(day, code), [day, code])
  const minuteEnd = pinned + 59
  const trades = tapeOfMinute(day, pinned)
  const i = all.indexOf(pinned)
  const step = (d: number) =>
    setPinned(all[Math.max(0, Math.min(all.length - 1, i + d))]!)
  return (
    <div className="flex flex-col gap-3">
      <nav
        aria-label="Trading day"
        className="flex gap-1.5 overflow-x-auto pb-1"
      >
        <button
          type="button"
          onClick={() => onDay("live")}
          className="bg-surface hover:bg-elevated text-up flex shrink-0 items-center gap-1 rounded-md border border-border px-3 text-xs font-semibold"
        >
          <i className="size-1.5 rounded-full bg-current" /> Today · live
        </button>
        {KEPT_DAYS.map((d) => {
          const chg = (seeded(d + "ihsg")() - 0.5) * 3
          return (
            <button
              key={d}
              type="button"
              onClick={() => onDay(d)}
              className={cn(
                "bg-surface flex shrink-0 flex-col items-start rounded-md border px-2.5 py-1 text-left",
                d === day
                  ? "border-primary shadow-[inset_0_-2px_0_var(--accent-primary)]"
                  : "hover:bg-elevated border-border"
              )}
            >
              <span className="text-xs font-semibold">{dayShort(d)}</span>
              <span
                className={cn(
                  "num text-[10px]",
                  chg >= 0 ? "text-up" : "text-down"
                )}
              >
                IHSG {chg >= 0 ? "+" : ""}
                {chg.toFixed(2)}%
              </span>
            </button>
          )
        })}
      </nav>
      <div className={cn(GRID, "lg:h-[calc(100svh-12rem)]")}>
        <section className={CARD}>
          <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border p-3">
            <CodeSearch onPick={onCode} className="w-48" />
            <Quote day={day} code={code} t={minuteEnd} />
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              Click a candle to pin its minute
              <RecordedPill label={dayLabel(day).toUpperCase()} />
            </span>
          </header>
          <PastChart
            bars={bars}
            cursor={pinned}
            onPick={(m) => all.includes(m) && setPinned(m)}
            className="h-[420px] min-h-0 flex-1 p-2"
          />
          <footer className="border-t border-border px-3 py-1.5">
            <LwNotice />
          </footer>
        </section>
        <div className="flex min-h-0 flex-col gap-3">
          <PastWatchlist
            day={day}
            t={minuteEnd}
            code={code}
            onPick={onCode}
            title={`as of ${hm(pinned)}`}
            className="max-h-60 shrink-0 lg:max-h-[26%]"
          />
          <LadderView
            key={code}
            book={bookAt(day, code, minuteEnd)}
            className="shrink-0"
          />
          <PastTape
            code={code}
            trades={trades}
            onCode={onCode}
            title={`Running trades · ${hm(pinned)}`}
            className="min-h-40 flex-1"
            tools={
              <>
                <button
                  type="button"
                  onClick={() => step(-1)}
                  className="hover:bg-elevated rounded border border-border px-1.5 text-xs"
                  aria-label="Previous minute"
                >
                  ‹
                </button>
                <span className="num text-[11px] text-muted-foreground">
                  {hm(pinned)}–{hm(pinned + 60)}
                </span>
                <button
                  type="button"
                  onClick={() => step(1)}
                  className="hover:bg-elevated rounded border border-border px-1.5 text-xs"
                  aria-label="Next minute"
                >
                  ›
                </button>
              </>
            }
          />
        </div>
      </div>
    </div>
  )
}
