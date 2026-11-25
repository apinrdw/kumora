// What /holder-moves reads from its URL (spec apinrdw/kumora#673, "Pages"):
// the kind, the selected day, the move filter and the search, each left out
// at its default (Daily, the newest parsed day, All, none), so a plain link
// opens the newest day's moves.
import { WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { MOVE_KINDS, type MoveKind } from "@/domain/holdings"
import type { MoveFilter } from "@/lib/holder-moves"

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
    move: yield* field(MoveParam, raw.move),
    q: q === "" ? undefined : q,
  }
})

export const kindOf = (search: HolderMovesSearch) =>
  Effect.succeed<MoveKind>(search.kind ?? "daily")

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
