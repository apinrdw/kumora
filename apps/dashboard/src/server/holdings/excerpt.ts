// What a parse failure quotes of a report's text.
import { Effect } from "effect"

// A failure quotes at most 40 characters of the report, so its
// message stays short whatever a cell or line holds: one line of KSEI's
// report may be the whole 8 MiB entry.
const EXCERPT_LENGTH = 40

// `text`, cut to EXCERPT_LENGTH characters and an ellipsis when longer.
export const excerpt = (text: string) =>
  Effect.sync(() =>
    text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text
  )
