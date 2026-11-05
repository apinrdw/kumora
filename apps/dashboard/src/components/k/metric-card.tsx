import { Card } from "@workspace/ui/components/card"
import { cn } from "@workspace/ui/lib/utils"

import { Delta } from "./delta"
import { KSkeleton } from "./skeleton"
import { KSourceLine } from "./source-line"
import { KStatusPill } from "./status-pill"
import type { Freshness } from "@/domain/freshness"
import { kCard } from "./styles"

export type KMetricCardProps = {
  label: string
  /** Pre-formatted value (lib/format). null renders "—" and the no-data copy, never 0. */
  value: string | null
  unit?: string
  /** Percent change; sign, arrow and color derive from it. */
  change?: number | null
  /** Pre-formatted change text; defaults to `pct(change)`. */
  changeDisplay?: string
  period?: string
  source?: string
  /** ISO datetime. */
  asOf?: string
  freshness?: Freshness
  size?: "compact" | "regular"
  loading?: boolean
  className?: string
}

function valueTone(value: string | null, stale: boolean) {
  if (value === null) return "text-muted-foreground"
  return stale ? "text-secondary-text" : "text-foreground"
}

function MetricValue({
  value,
  unit,
  size = "regular",
  stale,
}: Pick<KMetricCardProps, "value" | "unit" | "size"> & { stale: boolean }) {
  return (
    <div
      className={cn(
        "num flex items-baseline gap-2",
        size === "regular"
          ? "text-[28px] leading-[34px] font-[650]"
          : "text-xl leading-7 font-semibold",
        valueTone(value, stale)
      )}
    >
      {value ?? "—"}
      {value !== null && unit && (
        <span className="font-sans text-xs leading-[18px] font-[450] text-muted-foreground">
          {unit}
        </span>
      )}
    </div>
  )
}

function MetricChange({
  value,
  change,
  changeDisplay,
  period,
}: Pick<KMetricCardProps, "value" | "change" | "changeDisplay" | "period">) {
  if (change != null) {
    return (
      <div className="flex items-center gap-1 text-[13px] leading-[18px] font-[450]">
        <Delta value={change} display={changeDisplay} />
        {period && <span className="ml-1 text-muted-foreground">{period}</span>}
      </div>
    )
  }
  if (value !== null) return null
  return (
    <div className="text-xs leading-[18px] text-muted-foreground">
      Belum ada data yang cukup untuk periode ini.
    </div>
  )
}

export function KMetricCard({
  label,
  value,
  source,
  asOf,
  freshness,
  loading = false,
  className,
  ...rest
}: KMetricCardProps) {
  if (loading) return <KSkeleton kind="metric" className={className} />
  const stale = freshness === "stale"
  return (
    <Card
      role="group"
      aria-label={label}
      className={cn(
        kCard,
        "min-w-[220px] gap-1",
        stale && "border-warning",
        className
      )}
    >
      <div className="text-secondary-text flex items-center justify-between gap-2 text-xs leading-[18px] font-[450]">
        <span>{label}</span>
        {freshness && <KStatusPill status={freshness} asOf={asOf} hideAsOf />}
      </div>
      <MetricValue {...rest} value={value} stale={stale} />
      <MetricChange {...rest} value={value} />
      <KSourceLine source={source} asOf={asOf} />
    </Card>
  )
}
