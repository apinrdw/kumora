import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"

import type { Freshness } from "@/domain/freshness"
import type { TradeSource } from "@/domain/trade"
import { asOf as formatAsOf } from "@/lib/format"

export const FRESHNESS = {
  live: {
    label: "LIVE",
    def: "Data real-time dari sesi Stockbit operator; bukan feed berlisensi.",
    className: "text-up",
  },
  delayed: {
    label: "DELAYED",
    def: "Data tertunda; lihat waktu pembaruan terakhir.",
    className: "text-warning",
  },
  eod: {
    label: "EOD",
    def: "Data akhir hari (end-of-day), bukan intraday.",
    className: "text-info",
  },
  stale: {
    label: "STALE",
    def: "Pembaruan terhenti; nilai terakhir yang valid tetap ditampilkan.",
    className: "border-warning text-warning",
  },
  unavailable: {
    label: "UNAVAILABLE",
    def: "Data belum tersedia untuk periode ini.",
    className: "text-down",
  },
  demo: {
    label: "DATA DEMO",
    def: "Data sintetis untuk demonstrasi, bukan data pasar.",
    className: "border-dashed border-neutral text-neutral",
  },
} as const satisfies Record<
  Freshness,
  { label: string; def: string; className: string }
>

export type KStatusPillProps = {
  status: Freshness
  /** Where the figure came from, beside the label: "LIVE · extension". */
  source?: TradeSource
  /** ISO datetime, rendered as "14.45 WIB". */
  asOf?: string
  /** Keep the time in the title and sr text only (dense rows). */
  hideAsOf?: boolean
  className?: string
}

export function KStatusPill({
  status,
  source,
  asOf,
  hideAsOf = false,
  className,
}: KStatusPillProps) {
  const meta = FRESHNESS[status]
  const time = asOf ? formatAsOf(asOf) : null
  const definition = meta.def + (time ? ` Pembaruan terakhir ${time}.` : "")
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
