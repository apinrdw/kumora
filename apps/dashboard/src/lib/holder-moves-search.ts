// What /holder-moves reads from its URL (spec apinrdw/kumora#673, "Pages"):
// the kind, each kind's selected period, the move filter and the search,
// each left out at its default (Daily, the newest parsed period, All, none),
// so a plain link opens the newest day's moves. Each kind keeps its own
// period, so the toggle returns to the one picked before.
import { WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { MOVE_KINDS, type MoveKind } from "@/domain/holdings"
import type { MoveFilter } from "@/lib/holder-moves"
import { Month } from "@/lib/stock-search"

// The filter as the URL spells it; absent for All.
const MOVE_PARAMS = {
  new: "new",
  up: "up",
  down: "down",
  "off-list": "off list",
} as const satisfies Record<string, Exclude<MoveFilter, "all">>
type MoveParam = keyof typeof MOVE_PARAMS
const MoveParam = Schema.Literals(
  Object.keys(MOVE_PARAMS) as ReadonlyArray<MoveParam>
)

const KindParam = Schema.Literals(MOVE_KINDS)

export interface HolderMovesSearch {
  // Absent for Daily.
  readonly kind?: MoveKind | undefined
  // Daily's trading day; absent for the newest parsed.
  readonly day?: WibDate | undefined
  // Monthly's above-1% month, `YYYY-MM`; absent for the newest parsed.
  readonly month?: string | undefined
  readonly move?: MoveParam | undefined
  // As typed; absent when empty.
  readonly q?: string | undefined
}

const field = <A>(schema: Schema.Codec<A>, raw: unknown) =>
  Effect.sync(() =>
    Option.getOrUndefined(Schema.decodeUnknownOption(schema)(raw))
  )

/**
 * Keeps the fields that parse and drops anything else. A dropped one is set
 * `undefined`: the router lays the validated search over the raw one, which
 * would keep it.
 */
export const parseHolderMovesSearch = Effect.fnUntraced(function* (
  raw: Record<string, unknown>
): Effect.fn.Return<HolderMovesSearch> {
  const q = yield* field(Schema.String, raw.q)
  const kind = yield* field(KindParam, raw.kind)
  return {
    kind: kind === "daily" ? undefined : kind,
    day: Option.getOrUndefined(Schema.decodeUnknownOption(WibDate)(raw.day)),
    month: yield* field(Month, raw.month),
    move: yield* field(MoveParam, raw.move),
    q: q === "" ? undefined : q,
  }
})

export const kindOf = (search: HolderMovesSearch) =>
  Effect.succeed<MoveKind>(search.kind ?? "daily")

// The selected period of the selected kind: a day or a month, as the URL
// spells it; undefined for the newest.
export const periodOf = (search: HolderMovesSearch) =>
  Effect.map(kindOf(search), (kind) =>
    kind === "daily" ? search.day : search.month
  )

// The search that picks `period` of `kind`, left out when it is the newest
// of `periods`.
export const periodSearch = (
  kind: MoveKind,
  period: string,
  periods: ReadonlyArray<string>
) =>
  Effect.sync((): HolderMovesSearch => {
    const newest = period === periods.at(-1)
    return kind === "daily"
      ? { day: newest ? undefined : WibDate.make(period) }
      : { month: newest ? undefined : period.slice(0, 7) }
  })

export const filterOf = (search: HolderMovesSearch) =>
  Effect.succeed<MoveFilter>(
    search.move === undefined ? "all" : MOVE_PARAMS[search.move]
  )

// `filter` as the URL's `move`.
export const moveSearch = (filter: MoveFilter) =>
  Effect.sync((): MoveParam | undefined =>
    (Object.keys(MOVE_PARAMS) as ReadonlyArray<MoveParam>).find(
      (param) => MOVE_PARAMS[param] === filter
    )
  )
