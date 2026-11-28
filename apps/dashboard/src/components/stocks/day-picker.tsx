// A trading day picker: the day before, a select of the days, the day after.
// The stock page's Daily holders and the Holder map pick their day with it.
import type { WibDate } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { kFocus } from "@/components/k/styles"
import { dayDateLabel } from "@/lib/stock-page-display"

const ICON_BUTTON = cn(
  "bg-surface grid size-7.5 place-items-center rounded-md border border-border text-[14px] disabled:cursor-default disabled:opacity-35",
  kFocus
)

export type DayPickerProps = {
  // Oldest first.
  days: ReadonlyArray<WibDate>
  // The day shown; one missing from `days` shows as a disabled option, with
  // the days either side of it a step away.
  day: WibDate
  onDay: (day: WibDate) => void
}

export function DayPicker({ days, day, onDay }: DayPickerProps) {
  const listed = days.includes(day)
  const previous = days.filter((each) => each < day).at(-1)
  const next = days.find((each) => each > day)
  const options = listed ? days : [...days, day].sort()
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label="Previous trading day"
        disabled={previous === undefined}
        onClick={() => previous && onDay(previous)}
        className={ICON_BUTTON}
      >
        ‹
      </button>
      <select
        aria-label="Trading day"
        value={day}
        onChange={(event) => {
          // An option's value is one of `days`: the only ones enabled.
          const picked = days.find((each) => each === event.target.value)
          if (picked !== undefined) onDay(picked)
        }}
        className={cn(
          "num bg-surface rounded-md border border-border px-2 py-1 text-[13px] font-semibold",
          kFocus
        )}
      >
        {options.map((each) => (
          <option key={each} value={each} disabled={!days.includes(each)}>
            {Effect.runSync(dayDateLabel(each))}
            {days.includes(each) ? "" : " · no report"}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="Next trading day"
        disabled={next === undefined}
        onClick={() => next && onDay(next)}
        className={ICON_BUTTON}
      >
        ›
      </button>
    </div>
  )
}
