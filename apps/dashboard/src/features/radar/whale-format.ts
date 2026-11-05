// The agreed line for a sweep, `13:42:35  ENRG  RG  Sweep buy  48.766 at 665  3,24B  198 freq`,
// and the words around it. Pure, and shared by Whale Radar and Whale Radar Live.
import type {
  Sweep,
  ThresholdPrior,
  ThresholdState,
  Wall,
} from "@/domain/trade"
import { plain } from "@/lib/format"
import { ORDER_CLOSE_MS } from "@/relay/routes"
import { WIB_MS } from "@/relay/trading-day"

/** 13:42:35 in WIB. `id-ID` would print dots. */
export const wib = (iso: string) =>
  new Date(Date.parse(iso) + WIB_MS).toISOString().slice(11, 19)

/** 48.766 */
export const lots = (n: number) => plain(Math.round(n))

/** 3,24B, 245M or 455K. */
export const money = (rupiah: number) => {
  if (rupiah >= 1e9) return `${plain(rupiah / 1e9, 2)}B`
  if (rupiah >= 1e6) return `${plain(Math.round(rupiah / 1e6))}M`
  return `${plain(Math.round(rupiah / 1e3))}K`
}

export const priceRange = ({ priceLow, priceHigh }: Sweep) =>
  priceLow === priceHigh
    ? plain(priceLow)
    : `${plain(priceLow)}–${plain(priceHigh)}`

export const sweepSide = ({ side }: Sweep) =>
  side === "buy" ? "Sweep buy" : "Sweep sell"

export const sweepLine = (s: Sweep) =>
  `${wib(s.tradedAt)}  ${s.symbol}  ${s.board}  ${sweepSide(s)}  ${lots(s.lots)} at ${priceRange(s)}  ${money(s.value)}  ${s.freq} freq`

const PRIOR_COPY: Record<ThresholdPrior, string> = {
  own: "own previous session",
  market: "market-wide prior",
  none: "no prior",
}

const judged = ({
  threshold,
  warmingUp,
}: Pick<Sweep, "threshold" | "warmingUp">) =>
  `threshold ${lots(threshold)} lots${warmingUp ? ", warming up" : ""}`

const SWEEP_CLOSE_COPY: Record<NonNullable<Sweep["closedBy"]>, string> = {
  "next-order": "closed by the next order",
  idle: `closed after ${ORDER_CLOSE_MS} ms idle`,
}

export const sweepDetail = (s: Sweep) =>
  `${s.closedBy ? SWEEP_CLOSE_COPY[s.closedBy] : "growing"} · ${judged(s)} · ${PRIOR_COPY[s.prior]}`

export const wallSide = ({ side }: Wall) =>
  side === "bid" ? "Bid wall" : "Offer wall"

/** Both counts are lower bounds: `liveprice` keeps about one match in five. */
export const wallLine = (w: Wall) =>
  `${wib(w.lastSeen)}  ${w.symbol}  ${wallSide(w)} ${plain(w.price)}  ≥${plain(w.hitsSeen)} hits  ≥${lots(w.lotsMatched)} lots`

export const wallState = (w: Wall) => {
  if (w.closedBy === "traded-through")
    return `gone, traded through ${wib(w.closedAt ?? w.lastSeen)}`
  if (w.closedBy === "idle") return `gone, no hit since ${wib(w.lastSeen)}`
  return `holding, last hit ${wib(w.lastSeen)}`
}

export const thresholdLine = (t: ThresholdState) => {
  const value = t.threshold === null ? "none yet" : `${lots(t.threshold)} lots`
  return `whale threshold ${value}${t.warmingUp ? ", warming up" : ""} · ${plain(t.ordersToday)} orders today · ${PRIOR_COPY[t.prior]}`
}

export type WhaleTone = "up" | "down" | "neutral"

export const TONE_DOT: Record<WhaleTone, string> = {
  up: "bg-up",
  down: "bg-down",
  neutral: "bg-border",
}

export type WhaleLogEntry = {
  readonly key: string
  readonly at: string
  readonly tone: WhaleTone
  readonly line: string
  readonly detail: string
  /** Still changing: a growing sweep, a holding wall. */
  readonly live: boolean
}

/** Today's sweeps and walls as one list, newest first. */
export const whaleLogEntries = (
  sweeps: ReadonlyArray<Sweep>,
  walls: ReadonlyArray<Wall>
): ReadonlyArray<WhaleLogEntry> =>
  [
    ...sweeps.map((s): WhaleLogEntry => ({
      key: `sweep:${s.day}:${s.symbol}:${s.firstNumber}`,
      at: s.tradedAt,
      tone: s.side === "buy" ? "up" : "down",
      line: sweepLine(s),
      detail: sweepDetail(s),
      live: s.open,
    })),
    ...walls.map((w): WhaleLogEntry => {
      const gone = w.closedAt !== null
      const held = w.side === "bid" ? "up" : "down"
      return {
        key: `wall:${w.day}:${w.symbol}:${w.firstOrderNumber}`,
        at: w.closedAt ?? w.lastSeen,
        tone: gone ? "neutral" : held,
        line: wallLine(w),
        detail: wallState(w),
        live: !gone,
      }
    }),
  ].sort((a, b) => b.at.localeCompare(a.at))
