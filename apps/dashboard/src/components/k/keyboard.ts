import { Effect } from "effect"

/** Enter or Space: the keys that activate a native button, for focusable non-button rows. */
export const isActivationKey = (key: string) =>
  Effect.sync(() => key === "Enter" || key === " ")
