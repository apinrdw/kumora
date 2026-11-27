// The Holder map's keys, one definition for the read and the view model: a
// holding's place.
import { Effect } from "effect"

// A holding's place: its stock and holder key. Unique, since a code holds
// no space.
export const placeOf = (code: string, holder: string) =>
  Effect.succeed(`${code} ${holder}`)
