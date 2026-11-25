// What an archive admin page's cards share: the card frame, the ledger row
// frame, and how a run's outcome reads.
import { cn } from "@workspace/ui/lib/utils"
import { useId, type CSSProperties, type ReactNode } from "react"

import type { RunOutcome } from "@/server/archive/run"

// A run's outcome is a dot and a word, not a KBadge: the badge's
// tones carry the market's up and down arrows, which read as a price move
// beside a run.
const OUTCOME = {
  running: { label: "Running", className: "text-info" },
  complete: { label: "Complete", className: "text-up" },
  partial: { label: "Partial", className: "text-warning" },
  failed: { label: "Failed", className: "text-down" },
} as const satisfies Record<RunOutcome, { label: string; className: string }>

export function RunStatus({ outcome }: { outcome: RunOutcome }) {
  const { label, className } = OUTCOME[outcome]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[13px] leading-5 font-semibold",
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full bg-current",
          outcome === "running" && "motion-safe:animate-pulse"
        )}
      />
      {label}
    </span>
  )
}

/**
 * A panel: its title and `aside` on a header row ruled off from the body,
 * which holds `children`.
 */
export function ArchiveCard({
  title,
  aside,
  children,
}: {
  title: ReactNode
  aside: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="bg-surface flex min-w-0 flex-col rounded-md border border-border text-sm text-foreground"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-border px-5 py-4">
        <h2
          id={id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xl leading-7 font-semibold tracking-[-0.01em] text-balance"
        >
          {title}
        </h2>
        {aside}
      </header>
      <div className="flex flex-col gap-5 px-5 pt-5 pb-6">{children}</div>
    </section>
  )
}

/**
 * One job in a ledger of jobs (ArchiveLedger): its name and when it ran on
 * the left, its counts in the middle on columns every row shares, its action
 * on the right, and what went wrong across the full width under them. On a
 * phone the action drops under the name, so two buttons never squeeze it.
 * `stats` is a `dl` and stays a direct child of the row, so a count is found
 * by its term within the row alone.
 */
export function ArchiveRow({
  title,
  meta,
  stats,
  aside,
  children,
}: {
  title: ReactNode
  meta: ReactNode
  stats: ReactNode
  aside: ReactNode
  children?: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="grid grid-cols-[minmax(0,1fr)] items-start gap-x-6 gap-y-4 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] @min-[88rem]:grid-cols-[minmax(0,25rem)_minmax(0,1fr)_auto] @min-[88rem]:gap-x-10"
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <h3
          id={id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px] leading-6 font-semibold"
        >
          {title}
        </h3>
        {meta}
      </div>
      <div className="justify-self-start sm:col-start-2 sm:row-start-1 sm:justify-self-auto @min-[88rem]:col-start-3">
        {aside}
      </div>
      {stats}
      {children}
    </section>
  )
}

// Where a row's counts sit: under the name until the ledger is wide enough
// that five counts' labels keep to one line between the name and the
// action. Every row of a ledger shares its count columns (ArchiveLedger's
// `stats`), so a row with fewer counts still lines up.
export const archiveRowStats =
  "col-span-full grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-[repeat(var(--archive-stats),minmax(0,1fr))] @min-[88rem]:col-span-1 @min-[88rem]:col-start-2 @min-[88rem]:row-start-1"

// Where a row's notes sit: under everything, the full width.
export const archiveRowNotes = "col-span-full flex flex-col gap-2"

/**
 * The jobs of an archive page, one ArchiveRow each, in one panel. `stats` is
 * how many count columns its rows share: the most counts any row has.
 */
export function ArchiveLedger({
  title,
  description,
  stats = 4,
  children,
}: {
  title: string
  description: ReactNode
  stats?: number
  children: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      style={{ "--archive-stats": stats } as CSSProperties}
      className="bg-surface @container overflow-hidden rounded-md border border-border"
    >
      <header className="bg-elevated/40 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border px-5 py-3">
        <h2 id={id} className="text-[15px] font-semibold">
          {title}
        </h2>
        <p className="text-secondary-text text-[13px]">{description}</p>
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  )
}
