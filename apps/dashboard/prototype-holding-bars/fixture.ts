// PROTOTYPE (wayfinder #382), throwaway: a made-up stock's KSEI series,
// Nov 2018 to Oct 2026, with two gap months, shaped like the stock page's
// `series`.
import { KSEI_TYPES, type KseiType } from "@/domain/holdings"
import type { SeriesMonth } from "@/server/holdings/stock-page"

const GAPS = new Set(["2020-04", "2023-09"])

const LOCAL: Record<KseiType, number> = {
  ID: 0.46,
  CP: 0.24,
  MF: 0.08,
  IB: 0.05,
  IS: 0.06,
  SC: 0.012,
  PF: 0.045,
  FD: 0.01,
  OT: 0.043,
}
const FOREIGN: Record<KseiType, number> = {
  ID: 0.03,
  CP: 0.48,
  MF: 0.2,
  IB: 0.16,
  IS: 0.03,
  SC: 0.02,
  PF: 0.05,
  FD: 0.005,
  OT: 0.025,
}

// A seeded generator, so every reload draws the same stock.
let seed = 7
const random = () => {
  seed = (seed * 16807) % 2147483647
  return (seed - 1) / 2147483646
}

const months = (() => {
  const out: Array<string> = []
  for (let year = 2018, month = 11; year < 2026 || month <= 10;) {
    out.push(`${year}-${String(month).padStart(2, "0")}`)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
})()

const SCRIPLESS = 4_200_000_000

export const series: ReadonlyArray<SeriesMonth> = months.map((month, index) => {
  if (GAPS.has(month)) return { month, holdings: undefined }
  const t = index / months.length
  // Foreign drifts from 38% to 29% of scripless, with noise.
  const foreignShare = 0.38 - 0.09 * t + (random() - 0.5) * 0.02
  const draw = (mix: Record<KseiType, number>, whole: number) => {
    const weights = KSEI_TYPES.map(
      (type) =>
        mix[type] *
        (1 + (random() - 0.5) * 0.25) *
        (type === "ID" ? 1 + 0.35 * t : 1)
    )
    const sum = weights.reduce((a, b) => a + b, 0)
    return Object.fromEntries(
      KSEI_TYPES.map((type, i) => [
        type,
        Math.round((weights[i]! / sum) * whole),
      ])
    ) as Record<KseiType, number>
  }
  return {
    month,
    holdings: {
      periodEnd: `${month}-28`,
      local: draw(LOCAL, SCRIPLESS * (1 - foreignShare)),
      foreign: draw(FOREIGN, SCRIPLESS * foreignShare),
    },
  }
})
