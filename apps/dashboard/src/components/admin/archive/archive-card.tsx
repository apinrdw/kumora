// What an archive admin page's cards share: the card frame and how a run's
// outcome reads.
import { useId, type ReactNode } from "react"

import type { KBadgeTone } from "@/components/k"
import type { RunOutcome } from "@/server/archive/run"

export const OUTCOME = {
  running: { label: "Running", tone: "info" },
  complete: { label: "Complete", tone: "up" },
  partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "down" },
} as const satisfies Record<RunOutcome, { label: string; tone: KBadgeTone }>

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
