import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconMinus,
} from "@tabler/icons-react"
import { cn } from "@workspace/ui/lib/utils"

import { direction, pct } from "@/lib/format"
import type { Direction } from "@/lib/format"

export const DIRECTION = {
  up: { Icon: IconArrowUpRight, tone: "text-up", word: "naik" },
  down: { Icon: IconArrowDownRight, tone: "text-down", word: "turun" },
  flat: { Icon: IconMinus, tone: "text-neutral", word: "tidak berubah" },
} as const satisfies Record<Direction, unknown>

export type DeltaProps = {
  /** Signed number; sign, arrow, color and the sr-only word derive from it. null renders "—". */
  value: number | null
  /** Pre-formatted text; defaults to `pct(value)`. */
  display?: string
  className?: string
}

/** A signed change: arrow + sign + color, plus "naik"/"turun" for screen readers. */
export function Delta({ value, display, className }: DeltaProps) {
  if (value === null) {
    return <span className={cn("num text-muted-foreground", className)}>—</span>
  }
  const d = DIRECTION[direction(value)]
  return (
    <span
      className={cn(
        "num inline-flex items-center gap-1 whitespace-nowrap",
        d.tone,
        className
      )}
    >
      <d.Icon aria-hidden className="size-4 shrink-0" stroke={1.75} />
      {display ?? pct(value)}
      <span className="sr-only"> {d.word}</span>
    </span>
  )
}
