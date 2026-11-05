import type { KSort } from "@/components/k"
import type { Sector, Symbol } from "@/domain/symbol"
import { isSymbol } from "@/domain/symbol-guard"
import { RADAR_TIMEFRAMES } from "./timeframes"
import type { Candidate, RadarTimeframe } from "./schema"

export type RadarSearch = { t?: Symbol }

/**
 * Route boundary: a malformed symbol drops to the default. `t` is checked for
 * shape only, since the candidates are loader data; the page falls back to the
 * top row when it is not among them. The key is always present because the
 * router merges this over the raw search, so an omitted key would let the raw
 * value through.
 */
export function parseRadarSearch(raw: Record<string, unknown>): RadarSearch {
  const wanted = typeof raw.t === "string" ? raw.t.toUpperCase() : undefined
  return {
    t: isSymbol(wanted) ? wanted : undefined,
  }
}

export const CONFIDENCE_BANDS = ["all", "50", "70"] as const
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number]

export const REGIMES = ["all", "accumulation", "distribution", "mixed"] as const
export type Regime = (typeof REGIMES)[number]

export type Filters = {
  timeframe: RadarTimeframe
  confidence: ConfidenceBand
  sector: Sector | "all"
  regime: Regime
  liquidOnly: boolean
  volumeAnomaly: boolean
}

export const DEFAULT_FILTERS: Filters = {
  timeframe: "5D",
  confidence: "all",
  sector: "all",
  regime: "all",
  liquidOnly: false,
  volumeAnomaly: false,
}

/** Volume at least twice the 20-session average. */
export const ANOMALY_VOLX = 2

/** Timeframe is a view setting, not a filter, so it never counts as active. */
export function activeFilterCount(f: Filters): number {
  return [
    f.confidence !== "all",
    f.sector !== "all",
    f.regime !== "all",
    f.liquidOnly,
    f.volumeAnomaly,
  ].filter(Boolean).length
}

export function matches(c: Candidate, f: Filters): boolean {
  if (f.confidence !== "all" && (c.confidence ?? -1) < Number(f.confidence))
    return false
  if (f.sector !== "all" && c.sector !== f.sector) return false
  if (f.regime !== "all" && c.ai !== f.regime) return false
  if (f.liquidOnly && c.liquidity !== "tinggi") return false
  if (f.volumeAnomaly && c.volx < ANOMALY_VOLX) return false
  return true
}

/** Flat row shape for KDataTable; `change` is resolved for the active timeframe. */
export type CandidateRow = Omit<Candidate, "change"> & { change: number }

export function toRow(c: Candidate, timeframe: RadarTimeframe): CandidateRow {
  return { ...c, change: c.change[timeframe] }
}

export const DEFAULT_SORT: KSort<CandidateRow> = {
  key: "confidence",
  dir: "desc",
}

export const TIMEFRAME_OPTIONS = RADAR_TIMEFRAMES.map((t) => ({
  value: t,
  label: t,
}))
/** The sectors the radar filter offers. */
export const RADAR_SECTORS = [
  "Keuangan",
  "Infrastruktur",
  "Energi",
  "Logam",
  "Industri",
] as const satisfies ReadonlyArray<Sector>

export const SECTOR_OPTIONS = [
  { value: "all" as const, label: "Semua sektor" },
  ...RADAR_SECTORS.map((s) => ({ value: s, label: s })),
]
export const CONFIDENCE_OPTIONS: ReadonlyArray<{
  value: ConfidenceBand
  label: string
}> = [
  { value: "all", label: "Semua keyakinan" },
  { value: "50", label: "Keyakinan ≥ 50" },
  { value: "70", label: "Keyakinan ≥ 70" },
]
export const REGIME_OPTIONS: ReadonlyArray<{ value: Regime; label: string }> = [
  { value: "all", label: "Semua rezim" },
  { value: "accumulation", label: "Akumulasi" },
  { value: "distribution", label: "Distribusi" },
  { value: "mixed", label: "Campuran" },
]
