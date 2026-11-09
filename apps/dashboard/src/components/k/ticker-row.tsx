import { cn } from "@workspace/ui/lib/utils"

import { idr, shares } from "@/lib/format"
import { Delta } from "./delta"
import { KStatusPill } from "./status-pill"
import type { Freshness } from "@/domain/freshness"
import { isActivationKey } from "./keyboard"
import { kFocus } from "./styles"

export type Density = "compact" | "comfortable"

export type KTickerRowProps = {
  ticker: string
  name?: string
  last: number | null
  changePct: number | null
  /** Shares traded, rendered "12.4 M shares". */
  volume: number | null
  freshness?: Freshness
  /** ISO datetime; shown in the card form, title-only in rows. */
  asOf?: string
  /** compact 36 · comfortable 44 · card (mobile). Cells and order stay identical. */
  density?: Density | "card"
  selected?: boolean
  onSelect?: () => void
  className?: string
}

const LAYOUT = {
  compact: "h-9 text-[13px]",
  comfortable: "h-11 text-sm",
  card: "h-auto grid-cols-[1fr_auto] grid-rows-[auto_auto] gap-y-2 rounded-md border border-border bg-surface p-3",
} as const

/** A watchlist row; place inside a `role="table"` container. */
export function KTickerRow({
  ticker,
  name,
  last,
  changePct,
  volume,
  freshness,
  asOf,
  density = "compact",
  selected = false,
  onSelect,
  className,
}: KTickerRowProps) {
  const card = density === "card"
  return (
    <div
      role="row"
      aria-selected={selected || undefined}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (isActivationKey(e.key) && onSelect) {
          e.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "hover:bg-elevated grid cursor-pointer grid-cols-[minmax(140px,1.6fr)_1fr_1fr_1.2fr_auto] items-center gap-3 border-b border-border px-3 leading-[18px] text-foreground transition-colors",
        "aria-selected:bg-selected aria-selected:shadow-[inset_2px_0_0_var(--accent-primary)]",
        kFocus,
        "focus-visible:outline-offset-[-2px]",
        LAYOUT[density],
        className
      )}
    >
      <div role="cell" className="flex min-w-0 flex-col">
        <span className="num font-[650]">{ticker}</span>
        {name && (
          <span className="text-secondary-text truncate text-[11px] leading-[14px]">
            {name}
          </span>
        )}
      </div>
      <div role="cell" className="num text-right whitespace-nowrap">
        {last === null ? "—" : idr(last)}
      </div>
      <div role="cell" className={cn("flex", !card && "justify-end")}>
        <Delta value={changePct} />
      </div>
      <div
        role="cell"
        className={cn(
          "num text-secondary-text whitespace-nowrap",
          card ? "col-start-1 text-left" : "text-right"
        )}
      >
        {volume === null ? "—" : shares(volume)}
      </div>
      <div role="cell" className={cn(card && "justify-self-end")}>
        {freshness && (
          <KStatusPill status={freshness} asOf={asOf} hideAsOf={!card} />
        )}
      </div>
    </div>
  )
}
