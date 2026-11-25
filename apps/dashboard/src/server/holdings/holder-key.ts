// The holder key: the name a holder is matched by across periods, shared by
// the above-1% (above-1.ts) and above-5% (above-5.ts) parsers, so a holder
// of either report keys the same way. Spec apinrdw/kumora#479, "Holder key",
// and #673, "Storage".
import { Effect } from "effect"

// Words the holder key drops once punctuation is spaces: legal forms, then
// honorifics.
// `DR` is kept: it marks TLKM's depositary-receipt account at BNY
// Mellon, `THE BANK OF NEW YORK MELLON DR`, and dropping it merges that with
// BNY Mellon's own holding in the same month. Without it the list merges no
// two holders within any month of Feb–Oct 2026. See apinrdw/kumora#478.
const DROPPED_WORDS: ReadonlySet<string> = new Set([
  "PT",
  "TBK",
  "TB",
  "PERSERO",
  "IR",
  "DRS",
  "DRA",
  "H",
  "HJ",
  "HJH",
  "PROF",
  "SE",
  "SH",
  "ST",
  "MM",
  "MBA",
  "MSC",
  "SKOM",
  "SPD",
  "ME",
  "MSI",
  "SKED",
])

// The name a ≥1% holder is matched by, from one month to the next and
// across a month's rows, and an above-5% holder from one trading day to the
// next (above-5.ts): INVESTOR_NAME uppercased, each of .,;:'"()-/& a
// space, DROPPED_WORDS dropped, and the words sorted. `IR. T. PERMADI
// RACHMAT` and `T PERMADI RACHMAT` are both `PERMADI RACHMAT T`.
// Both parsers store it, so a change here bumps ABOVE_1_PARSER_VERSION and
// ABOVE_5_PARSER_VERSION.
export const holderKey = (name: string) =>
  Effect.sync(() =>
    name
      .toUpperCase()
      .replaceAll(/[.,;:'"()\-/&]/g, " ")
      .split(/\s+/)
      .filter((word) => word !== "" && !DROPPED_WORDS.has(word))
      .sort()
      .join(" ")
  )
