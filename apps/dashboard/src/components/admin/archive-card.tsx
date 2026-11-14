// What the shareholding archive page's cards share: the card frame and how a
// run's outcome reads.
import { cn } from "@workspace/ui/lib/utils"
import { useId, type ReactNode } from "react"

import { kCard, type KBadgeTone } from "@/components/k"
import type { ArchiveRunResult } from "@/server/shareholding/run-result"

export const OUTCOME = {
  running: { label: "Running", tone: "info" },
  complete: { label: "Complete", tone: "up" },
  partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "down" },
} as const satisfies Record<
  ArchiveRunResult["outcome"],
  { label: string; tone: KBadgeTone }
>

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
    <section aria-labelledby={id} className={cn(kCard, "flex flex-col gap-4")}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <h2
          id={id}
          className="flex items-center gap-3 text-[15px] font-semibold"
        >
          {title}
        </h2>
        {aside}
      </header>
      {children}
    </section>
  )
}
