// The stock page panels' single-choice buttons and month tabs, shared by
// Shareholders composition and Holder size, and the chip groups Holding
// composition and Holder size switch their view with.
import { cn } from "@workspace/ui/lib/utils"
import type { StockCode } from "@workspace/relay"
import { Effect } from "effect"
import type { ReactNode } from "react"

import { KChip } from "@/components/k/chip"
import { kFocus } from "@/components/k/styles"
import { KTooltip } from "@/components/k/tooltip"
import { monthLabel } from "@/lib/stock-page-display"

export function Picks<Value extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string
  options: ReadonlyArray<{ value: Value; label: string }>
  value: Value
  onPick: (value: Value) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-2"
    >
      {options.map((option) => (
        <KChip
          key={option.value}
          selected={option.value === value}
          onSelectedChange={() => onPick(option.value)}
        >
          {option.label}
        </KChip>
      ))}
    </div>
  )
}

// A pressed-or-not button of a single choice. An unavailable one stays
// focusable, so its tooltip says why.
export function Choice({
  pressed,
  unavailable,
  onPick,
  className,
  children,
}: {
  pressed: boolean
  unavailable: string | undefined
  onPick: () => void
  className: string
  children: ReactNode
}) {
  const button = (
    <button
      type="button"
      aria-pressed={pressed}
      aria-disabled={unavailable !== undefined}
      onClick={() => unavailable === undefined && onPick()}
      className={cn(
        "border border-border whitespace-nowrap",
        kFocus,
        unavailable === undefined
          ? "hover:bg-elevated aria-pressed:border-up aria-pressed:text-up aria-pressed:font-semibold"
          : "cursor-not-allowed opacity-40",
        className
      )}
    >
      {children}
    </button>
  )
  return unavailable === undefined ? (
    button
  ) : (
    <KTooltip content={unavailable}>{button}</KTooltip>
  )
}

// One tab per report month, a month the stock has no row in disabled.
export function MonthTabs({
  code,
  months,
  selected,
  onMonth,
}: {
  code: StockCode
  months: ReadonlyArray<{ readonly dataDate: string; readonly held: boolean }>
  selected: string
  onMonth: (dataDate: string) => void
}) {
  return (
    <div
      role="group"
      aria-label="Month"
      className="grid grid-cols-4 gap-1.5 sm:grid-cols-8"
    >
      {months.map(({ dataDate, held }) => (
        <Choice
          key={dataDate}
          pressed={dataDate === selected}
          unavailable={
            held
              ? undefined
              : `${code} isn't in ${Effect.runSync(monthLabel(dataDate))}'s report.`
          }
          onPick={() => onMonth(dataDate)}
          className="rounded-sm px-1 py-1.5 text-[12px]"
        >
          {Effect.runSync(monthLabel(dataDate))}
        </Choice>
      ))}
    </div>
  )
}
