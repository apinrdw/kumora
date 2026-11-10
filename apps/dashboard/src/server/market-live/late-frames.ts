import { DateTime } from "effect"

// Both of a feed's connections carry the same frames, so one may deliver a
// frame the other already applied over. Whether a frame timed `at` is newer
// than what is held, timed `held`, which nothing is until the first.
export const newerThanHeld = (
  at: DateTime.Utc,
  held: DateTime.Utc | undefined
) => held === undefined || DateTime.isGreaterThan(at, held)
