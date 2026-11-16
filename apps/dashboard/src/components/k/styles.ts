/**
 * KUMORA focus treatment: a 2px accent outline offset 2px, replacing
 * shadcn's ring-3. `outline-solid` is needed because the primitives set
 * `outline-none`, which zeroes Tailwind's outline-style variable.
 */
export const kFocus =
  "outline-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid"

/** The tooltip surface: KTooltip's content and Holding composition's Bars
 * tooltip body. */
export const kTooltip =
  "bg-elevated max-w-[280px] min-w-40 rounded-xs border border-border px-3 py-2 text-xs leading-[18px] font-normal text-foreground shadow-popover"

/** The shared card surface (bundle.css `.k-card`). */
export const kCard =
  "gap-0 overflow-visible rounded-md border border-border bg-surface p-4 text-sm text-foreground ring-0"
