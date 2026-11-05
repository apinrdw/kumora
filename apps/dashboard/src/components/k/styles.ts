/**
 * KUMORA focus treatment: a 2px accent outline offset 2px, replacing
 * shadcn's ring-3. `outline-solid` is needed because the primitives set
 * `outline-none`, which zeroes Tailwind's outline-style variable.
 */
export const kFocus =
  "outline-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid"

/** The shared card surface (bundle.css `.k-card`). */
export const kCard =
  "gap-0 overflow-visible rounded-md border border-border bg-surface p-4 text-sm text-foreground ring-0"
