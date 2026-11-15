// A whole split two ways, such as Retail vs Institution or Local vs
// Foreign, as each side's share of it.
import { Effect } from "effect"

declare const made: unique symbol

// Each side 0 to 1, the two summing to 1. Only `split` makes one, so a
// side is never shown as what the other leaves of 1.
export type Split = {
  readonly left: number
  readonly right: number
} & { readonly [made]: true }

// The split of `left` and `right` shares, or undefined when both are 0: a
// split of nothing is no split, never one side at 100%.
export const split = (left: number, right: number) =>
  Effect.sync(() => {
    const whole = left + right
    return whole === 0
      ? undefined
      : ({ left: left / whole, right: right / whole } as Split)
  })
