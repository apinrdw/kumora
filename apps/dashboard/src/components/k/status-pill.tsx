import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import type { Freshness } from "@/domain/freshness"
import { asOf as formatAsOf } from "@/lib/format"

type TradeSource = "upstream" | "extension" | "none"

export const FRESHNESS = {
  live: {
    label: "LIVE",
    def: "Real-time data.",
    className: "text-up",
  },
  delayed: {
    label: "DELAYED",
    def: "Delayed data; see the last update time.",
    className: "text-warning",
  },
  eod: {
    label: "EOD",
    def: "End-of-day data, not intraday.",
    className: "text-info",
  },
  stale: {
    label: "STALE",
    def: "Updates have stopped; the last valid values stay on screen.",
    className: "border-warning text-warning",
  },
  unavailable: {
    label: "UNAVAILABLE",
    def: "No data available for this period yet.",
    className: "text-down",
  },
  demo: {
    label: "DATA DEMO",
    def: "Synthetic demo data, not market data.",
    className: "border-dashed border-neutral text-neutral",
  },
  recorded: {
    label: "RECORDED",
    def: "A recorded trading day, not live.",
    className: "text-info",
  },
} as const satisfies Record<
  Freshness,
  { label: string; def: string; className: string }
>

export type KStatusPillProps = {
  status: Freshness
  /** Where the figure came from, beside the label: "LIVE · extension". */
  source?: TradeSource
  /** ISO datetime, rendered as "14:45 WIB". */
  asOf?: string
  /** Keep the time in the title and sr text only (dense rows). */
  hideAsOf?: boolean
  /** Why, ahead of the definition in the tooltip: "Relay offline". */
  reason?: string
  className?: string
}

export function KStatusPill({
  status,
  source,
  asOf,
  hideAsOf = false,
  reason,
  className,
}: KStatusPillProps) {
  const meta = FRESHNESS[status]
  const time = asOf ? Effect.runSync(formatAsOf(asOf)) : null
  const definition =
    (reason ? `${reason}. ` : "") +
    meta.def +
    (time ? ` Last updated ${time}.` : "")
  return (
    <Badge
      variant="outline"
      title={definition}
      className={cn(
        "bg-elevated h-[22px] cursor-help gap-1 rounded-full border-border px-2 text-[11px] leading-4 font-medium tracking-[0.04em] uppercase",
        meta.className,
        className
      )}
    >
      <i aria-hidden className="size-1.5 rounded-full bg-current" />
      {meta.label}
      {source && <span className="normal-case">· {source}</span>}
      {time && !hideAsOf && (
        <span className="num ml-1 tracking-normal text-muted-foreground normal-case">
          {time}
        </span>
      )}
      <span className="sr-only">. {definition}</span>
    </Badge>
  )
}
