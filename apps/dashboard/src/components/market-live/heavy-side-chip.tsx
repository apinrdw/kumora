// The heavy side chip (apinrdw/kumora#601, #604): "big orders" in the warn
// colour, "small orders" in grey, on the scanner's rows and the Book
// readout's imbalance line.
import type { HeavySide } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"

import { ORDERS } from "@/lib/book-readings"

export function HeavySideChip({ heavy }: { heavy: HeavySide }) {
  return (
    <span
      aria-label="Heavy side"
      className={cn(
        "rounded-full border px-1.5 text-[10px] whitespace-nowrap",
        heavy.orders === "big"
          ? "border-warning/70 text-warning"
          : "border-border text-muted-foreground"
      )}
    >
      {ORDERS[heavy.orders]}
    </span>
  )
}
