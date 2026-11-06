// PROTOTYPE, throwaway: a fake merged Stockbit + Ajaib relay for the Market Live layout prototype.
import { useEffect, useState } from "react"

import type { Freshness } from "@/domain/freshness"

export type FeedName = "stockbit" | "ajaib"

export type Trade = {
  tradeNumber: number
  /** UTC seconds. */
  time: number
  code: string
  price: number
  lots: number
  side: "B" | "S"
  feeds: ReadonlyArray<FeedName>
}

export type Bar = {
  /** UTC seconds, start of the minute. */
  time: number
  open: number
  high: number
  low: number
  close: number
  lots: number
}

export type StockInfo = { code: string; name: string; prevClose: number }

export const STOCKS: ReadonlyArray<StockInfo> = [
  { code: "BBCA", name: "Bank Central Asia Tbk.", prevClose: 9275 },
  {
    code: "BBRI",
    name: "Bank Rakyat Indonesia (Persero) Tbk.",
    prevClose: 4130,
  },
  { code: "BMRI", name: "Bank Mandiri (Persero) Tbk.", prevClose: 5450 },
  {
    code: "BBNI",
    name: "Bank Negara Indonesia (Persero) Tbk.",
    prevClose: 4380,
  },
  { code: "TLKM", name: "Telkom Indonesia (Persero) Tbk.", prevClose: 2780 },
  { code: "ASII", name: "Astra International Tbk.", prevClose: 4920 },
  { code: "GOTO", name: "GoTo Gojek Tokopedia Tbk.", prevClose: 68 },
  { code: "ANTM", name: "Aneka Tambang Tbk.", prevClose: 1745 },
  { code: "ADRO", name: "Alamtri Resources Indonesia Tbk.", prevClose: 2410 },
  { code: "BREN", name: "Barito Renewables Energy Tbk.", prevClose: 7350 },
  { code: "AMMN", name: "Amman Mineral Internasional Tbk.", prevClose: 8650 },
  { code: "UNVR", name: "Unilever Indonesia Tbk.", prevClose: 1890 },
  { code: "ICBP", name: "Indofood CBP Sukses Makmur Tbk.", prevClose: 11250 },
  { code: "PGAS", name: "Perusahaan Gas Negara Tbk.", prevClose: 1585 },
  { code: "MDKA", name: "Merdeka Copper Gold Tbk.", prevClose: 1930 },
  { code: "BUKA", name: "Bukalapak.com Tbk.", prevClose: 142 },
  { code: "PTBA", name: "Bukit Asam Tbk.", prevClose: 2690 },
  { code: "INCO", name: "Vale Indonesia Tbk.", prevClose: 3720 },
  { code: "CPIN", name: "Charoen Pokphand Indonesia Tbk.", prevClose: 4710 },
  { code: "MEDC", name: "Medco Energi Internasional Tbk.", prevClose: 1205 },
]

/** IDX price fractions. */
function tick(price: number): number {
  if (price < 200) return 1
  if (price < 500) return 2
  if (price < 2000) return 5
  if (price < 5000) return 10
  return 25
}

function seeded(seed: string) {
  let h = 2166136261
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

// The simulated session opens 09:00 WIB today; "now" starts at 10:40 WIB and runs in real time.
const today = new Date()
const SESSION_OPEN =
  Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
    2,
    0,
    0
  ) / 1000
const loadedAt = Date.now()
export function simNow(): number {
  return SESSION_OPEN + 100 * 60 + (Date.now() - loadedAt) / 1000
}

/** One random tick, pulled back toward `anchor` (the previous close) past ±4%. */
function step(price: number, r: number, anchor: number): number {
  const t = tick(price)
  const pull = (price - anchor) / anchor
  const down = 0.42 + (pull > 0.04 ? 0.12 : pull < -0.04 ? -0.12 : 0)
  const up = down + 0.16
  const move = r < down ? -t : r > up ? t : 0
  return Math.max(t, price + move)
}

/** A stock code's totals since the open: value in rupiah, volume in lots, frequency in trades. */
export type DayStats = { value: number; lots: number; freq: number }
const dayStats = new Map<string, DayStats>()

const historyCache = new Map<string, ReadonlyArray<Bar>>()

/** 1-minute bars from the open to the minute before now, as the relayed history would arrive. */
export function history(code: string): ReadonlyArray<Bar> {
  const cached = historyCache.get(code)
  if (cached) return cached
  const stock = STOCKS.find((s) => s.code === code) ?? STOCKS[0]!
  const rand = seeded(code)
  const bars: Array<Bar> = []
  let price = stock.prevClose
  const end = Math.floor(simNow() / 60) * 60
  for (let time = SESSION_OPEN; time < end; time += 60) {
    const open = price
    let high = open
    let low = open
    for (let i = 0; i < 6; i++) {
      price = step(price, rand(), stock.prevClose)
      high = Math.max(high, price)
      low = Math.min(low, price)
    }
    bars.push({
      time,
      open,
      high,
      low,
      close: price,
      lots: Math.round(3_000 + rand() * 12_000),
    })
  }
  historyCache.set(code, bars)
  dayStats.set(code, {
    value: bars.reduce((sum, b) => sum + b.lots * b.close * 100, 0),
    lots: bars.reduce((sum, b) => sum + b.lots, 0),
    freq: bars.reduce((sum, b) => sum + Math.round(b.lots / 60), 0),
  })
  lastPrice.set(code, price)
  return bars
}

const lastPrice = new Map<string, number>()
function priceOf(code: string): number {
  const known = lastPrice.get(code)
  if (known !== undefined) return known
  const bars = history(code)
  return bars.at(-1)?.close ?? STOCKS.find((s) => s.code === code)!.prevClose
}

type Listener = (trade: Trade) => void

export type FakeFeed = {
  /** Newest first, capped. */
  tape: Array<Trade>
  state: Record<FeedName, Freshness>
  focus: string
  subscribe: (fn: Listener) => () => void
  toggle: (feed: FeedName) => void
  last: (code: string) => number
  stats: (code: string) => DayStats
}

function createFeed(): FakeFeed {
  const listeners = new Set<Listener>()
  let tradeNumber = 4_812_000
  const rand = Math.random
  const feed: FakeFeed = {
    tape: [],
    state: { stockbit: "live", ajaib: "live" },
    focus: "BBCA",
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    toggle(name) {
      feed.state[name] = feed.state[name] === "live" ? "stale" : "live"
    },
    last: priceOf,
    stats(code) {
      if (!dayStats.has(code)) history(code)
      return dayStats.get(code)!
    },
  }
  if (typeof window === "undefined") return feed
  setInterval(() => {
    const live = (["stockbit", "ajaib"] as const).filter(
      (f) => feed.state[f] === "live"
    )
    if (live.length === 0) return
    // Whole market: ~25 trades/s, a quarter of them on the focused code so its chart moves.
    const n = Math.floor(rand() * 3)
    for (let i = 0; i < n; i++) {
      const code =
        rand() < 0.25
          ? feed.focus
          : STOCKS[Math.floor(rand() * STOCKS.length)]!.code
      const price = step(
        priceOf(code),
        rand(),
        STOCKS.find((s) => s.code === code)!.prevClose
      )
      lastPrice.set(code, price)
      const trade: Trade = {
        tradeNumber: ++tradeNumber,
        time: simNow(),
        code,
        price,
        // About 1 in 80 is a block trade, so some cross the 1 B big-trade line.
        lots:
          rand() < 0.0125
            ? Math.ceil(1_000 + rand() * 20_000)
            : Math.ceil(rand() ** 4 * 300),
        side: rand() < 0.5 ? "B" : "S",
        feeds: live.length === 2 && rand() < 0.04 ? [live[0]!] : live,
      }
      const st = feed.stats(code)
      st.value += trade.price * trade.lots * 100
      st.lots += trade.lots
      st.freq += 1
      feed.tape.unshift(trade)
      if (feed.tape.length > 400) feed.tape.length = 400
      for (const fn of listeners) fn(trade)
    }
  }, 80)
  return feed
}

export const FEED = createFeed()

/** Re-renders at `hz` with a snapshot of the tape; per-trade work stays out of React. */
export function useTape(hz = 4): ReadonlyArray<Trade> {
  const [snap, setSnap] = useState<ReadonlyArray<Trade>>([])
  useEffect(() => {
    const id = setInterval(() => setSnap(FEED.tape.slice(0, 200)), 1000 / hz)
    return () => clearInterval(id)
  }, [hz])
  return snap
}

const timeSec = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Asia/Jakarta",
})
export function hms(utcSeconds: number): string {
  return timeSec.format(new Date(utcSeconds * 1000))
}
