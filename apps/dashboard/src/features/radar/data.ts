import { Confidence } from "@/domain/signal"
import { Symbol } from "@/domain/symbol"
import { IsoDateTime } from "@/domain/time"
import type { PricePoint } from "@/domain/quote"
import type { AIInput } from "@/domain/signal"
import type { WhalesToday } from "@/domain/trade"
import type { Candidate, RadarSnapshot } from "./schema"

/** Synthetic demo fixtures ported from WhaleRadar.dc.html. Every surface carries DATA DEMO. */

const AS_OF = IsoDateTime.make("2026-10-23T07:45:00Z")
const BROKER_AS_OF = IsoDateTime.make("2026-10-22T09:00:00Z")
const COMPUTED_AT = IsoDateTime.make("2026-10-23T07:46:00Z")
const MODEL_VERSION = "sm-flow 0.9.2"

const SESSIONS = [
  "28 Sep",
  "29 Sep",
  "30 Sep",
  "1 Okt",
  "2 Okt",
  "5 Okt",
  "6 Okt",
  "7 Okt",
  "8 Okt",
  "9 Okt",
  "12 Okt",
  "13 Okt",
  "14 Okt",
  "15 Okt",
  "16 Okt",
  "19 Okt",
  "20 Okt",
  "21 Okt",
  "22 Okt",
  "23 Okt",
] as const

/** Written with plain literals; `candidate()` brands them. */
type Seed = Omit<Candidate, "symbol" | "confidence" | "change" | "history"> & {
  symbol: string
  confidence: number | null
  chg1D: number
  /** Price 20 sessions ago relative to last, e.g. 0.94. */
  start: number
  avgVolume: number
}

/** Deterministic closes from `start × last` to `last`, with a fixed wiggle so SSR and client agree. */
function buildHistory(s: Seed): ReadonlyArray<PricePoint> {
  const n = SESSIONS.length
  const prev = s.last / (1 + s.chg1D / 100)
  return SESSIONS.map((label, i) => {
    const t = i / (n - 2)
    const base = s.last * s.start + (prev - s.last * s.start) * t
    const wiggle = Math.sin(i * 1.7 + s.last) * s.last * 0.008
    const price =
      i === n - 1 ? s.last : i === n - 2 ? prev : Math.round(base + wiggle)
    const volume = Math.round(
      s.avgVolume *
        (i === n - 1 ? s.volx : 0.8 + 0.4 * Math.abs(Math.cos(i * 2.3)))
    )
    return { label, price: Math.round(price), volume }
  })
}

function pctChange(from: number, to: number): number {
  return Math.round((to / from - 1) * 10000) / 100
}

function candidate(s: Seed): Candidate {
  const { chg1D, start: _start, avgVolume: _avgVolume, ...rest } = s
  const history = buildHistory(s)
  const close = (back: number) => history[history.length - 1 - back].price
  return {
    ...rest,
    symbol: Symbol.make(s.symbol),
    confidence: s.confidence === null ? null : Confidence.make(s.confidence),
    history,
    change: {
      "1D": chg1D,
      "5D": pctChange(close(5), s.last),
      "1M": pctChange(close(19), s.last),
    },
  }
}

export const CANDIDATES: ReadonlyArray<Candidate> = [
  candidate({
    symbol: "BBCA",
    name: "Bank Central Asia Tbk.",
    sector: "Keuangan",
    liquidity: "tinggi",
    last: 9275,
    chg1D: 1.35,
    start: 0.95,
    avgVolume: 61e6,
    volx: 2.4,
    flow: 86.2e9,
    ai: "accumulation",
    confidence: 78,
    updated: AS_OF,
    hypothesis:
      "Pola akumulasi: volume di atas rata-rata disertai net beli broker terkonsentrasi, sementara harga bertahan di atas VWAP.",
    evidence: [
      {
        label: "Volume vs rata-rata 20 hari",
        value: "2,4×",
        source: "Feed harga",
      },
      {
        label: "Net beli 5 broker teratas",
        value: "+Rp86,2 miliar",
        source: "Feed broker (EOD)",
      },
      { label: "Harga vs VWAP", value: "+0,8%", source: "Feed harga" },
    ],
    counter: [
      "Konsentrasi broker turun 2 hari terakhir",
      "RSI jangka pendek mendekati 70",
    ],
    contributions: [
      { label: "Volume vs rata-rata 20 hari", weight: 0.42 },
      { label: "Konsentrasi net beli 5 broker", weight: 0.31 },
      { label: "Harga vs VWAP", weight: 0.14 },
      { label: "RSI jangka pendek", weight: -0.18 },
    ],
  }),
  candidate({
    symbol: "ANTM",
    name: "Aneka Tambang Tbk.",
    sector: "Logam",
    liquidity: "tinggi",
    last: 1985,
    chg1D: 2.58,
    start: 0.88,
    avgVolume: 118e6,
    volx: 3.1,
    flow: 54.7e9,
    ai: "accumulation",
    confidence: 71,
    updated: AS_OF,
    hypothesis:
      "Pola akumulasi: tiga broker menyerap 61% volume beli, harga menguat dengan volume meningkat.",
    evidence: [
      {
        label: "Konsentrasi 3 broker (beli)",
        value: "61%",
        source: "Feed broker (EOD)",
      },
      {
        label: "Volume vs rata-rata 20 hari",
        value: "3,1×",
        source: "Feed harga",
      },
      {
        label: "Net beli asing",
        value: "+Rp21,4 miliar",
        source: "Feed broker (EOD)",
      },
    ],
    counter: ["Harga sudah +9% dalam 5 sesi", "Sektor logam volatil pekan ini"],
    contributions: [
      { label: "Konsentrasi broker", weight: 0.38 },
      { label: "Volume vs rata-rata", weight: 0.33 },
      { label: "Net beli asing", weight: 0.12 },
      { label: "Kenaikan 5 sesi", weight: -0.21 },
    ],
  }),
  candidate({
    symbol: "TLKM",
    name: "Telkom Indonesia Tbk.",
    sector: "Infrastruktur",
    liquidity: "tinggi",
    last: 2860,
    chg1D: -1.32,
    start: 1.06,
    avgVolume: 92e6,
    volx: 1.8,
    flow: -42.1e9,
    ai: "distribution",
    confidence: 64,
    updated: AS_OF,
    hypothesis:
      "Pola distribusi: net jual broker besar berlanjut 4 sesi dengan harga di bawah VWAP.",
    evidence: [
      {
        label: "Net jual 5 broker teratas",
        value: "−Rp42,1 miliar",
        source: "Feed broker (EOD)",
      },
      {
        label: "Sesi net jual beruntun",
        value: "4",
        source: "Feed broker (EOD)",
      },
      { label: "Harga vs VWAP", value: "−1,1%", source: "Feed harga" },
    ],
    counter: ["Volume hanya 1,8× rata-rata", "Net beli ritel meningkat"],
    contributions: [
      { label: "Net jual broker besar", weight: 0.4 },
      { label: "Sesi beruntun", weight: 0.22 },
      { label: "Harga vs VWAP", weight: 0.15 },
      { label: "Net beli ritel", weight: -0.14 },
    ],
  }),
  candidate({
    symbol: "ASII",
    name: "Astra International Tbk.",
    sector: "Industri",
    liquidity: "tinggi",
    last: 4910,
    chg1D: 0,
    start: 1.01,
    avgVolume: 34e6,
    volx: 1.1,
    flow: 3.4e9,
    ai: "mixed",
    confidence: 51,
    updated: IsoDateTime.make("2026-10-23T07:44:00Z"),
    hypothesis:
      "Sinyal campuran: net beli tipis dengan volume normal; belum ada pola yang dominan.",
    evidence: [
      {
        label: "Net broker flow",
        value: "+Rp3,4 miliar",
        source: "Feed broker (EOD)",
      },
      {
        label: "Volume vs rata-rata 20 hari",
        value: "1,1×",
        source: "Feed harga",
      },
    ],
    counter: ["Harga flat 3 sesi", "Broker beli dan jual sama-sama tersebar"],
    contributions: [
      { label: "Net broker flow", weight: 0.12 },
      { label: "Volume", weight: 0.05 },
      { label: "Dispersi broker", weight: -0.16 },
    ],
  }),
  candidate({
    symbol: "BMRI",
    name: "Bank Mandiri (Persero) Tbk.",
    sector: "Keuangan",
    liquidity: "tinggi",
    last: 6425,
    chg1D: -0.39,
    start: 0.98,
    avgVolume: 48e6,
    volx: 1.4,
    flow: 18.9e9,
    ai: "accumulation",
    confidence: 56,
    updated: AS_OF,
    hypothesis:
      "Indikasi akumulasi lemah: net beli positif tetapi volume belum meyakinkan.",
    evidence: [
      {
        label: "Net beli 5 broker teratas",
        value: "+Rp18,9 miliar",
        source: "Feed broker (EOD)",
      },
      {
        label: "Volume vs rata-rata 20 hari",
        value: "1,4×",
        source: "Feed harga",
      },
    ],
    counter: ["Harga turun tipis hari ini"],
    contributions: [
      { label: "Net beli broker", weight: 0.28 },
      { label: "Volume", weight: 0.1 },
      { label: "Harga hari ini", weight: -0.09 },
    ],
  }),
  candidate({
    symbol: "MDKA",
    name: "Merdeka Copper Gold Tbk.",
    sector: "Logam",
    liquidity: "sedang",
    last: 2130,
    chg1D: 2.9,
    start: 0.91,
    avgVolume: 41e6,
    volx: 3.6,
    flow: null,
    ai: "insufficient",
    confidence: null,
    updated: AS_OF,
    hypothesis: "",
    evidence: [
      {
        label: "Volume vs rata-rata 20 hari",
        value: "3,6×",
        source: "Feed harga",
      },
    ],
    counter: [],
    contributions: [],
  }),
]

const AI_INPUTS: ReadonlyArray<AIInput> = [
  { label: "OHLCV harian 60 sesi", source: "Feed harga", asOf: AS_OF },
  {
    label: "Net beli/jual per broker (EOD)",
    source: "Feed broker",
    asOf: BROKER_AS_OF,
  },
  { label: "VWAP intraday", source: "Dihitung dari feed harga" },
]

const AI_LIMITATIONS: ReadonlyArray<string> = [
  "Data broker EOD: aktivitas intraday hari ini belum termasuk.",
  "Model tidak mengetahui identitas pihak di balik broker.",
  "Skor tidak dikalibrasi terhadap imbal hasil.",
]

/** The demo's day: the relay's feeds have nothing to say here. */
export const EMPTY_WHALES_TODAY: WhalesToday = {
  seq: 0,
  day: null,
  sweeps: [],
  sweepsTotal: 0,
  leaderboard: [],
  walls: [],
  wallCoverage: [],
  thresholds: { symbols: 0, warmingUp: 0 },
  provenance: {
    feed: "stockbit-running-trades",
    source: "none",
    asOf: null,
    freshness: "demo",
  },
  liveprice: {
    feed: "stockbit-liveprice",
    source: "none",
    asOf: null,
    freshness: "demo",
  },
}

export const RADAR_SNAPSHOT: RadarSnapshot = {
  candidates: CANDIDATES,
  aiInputs: AI_INPUTS,
  aiLimitations: AI_LIMITATIONS,
  asOf: AS_OF,
  brokerAsOf: BROKER_AS_OF,
  computedAt: COMPUTED_AT,
  modelVersion: MODEL_VERSION,
  whales: EMPTY_WHALES_TODAY,
}
