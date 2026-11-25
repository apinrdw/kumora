// What /holder-moves reads from its URL (spec apinrdw/kumora#673, "Pages"):
// the kind, each kind's selected period, the move filter and the search,
// each left out at its default (Daily, the newest parsed period, All, none),
// so a plain link opens the newest day's moves. Each kind keeps its own
// period, so the toggle returns to the one picked before.
import { WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import {
  Month,
  monthOf,
  MOVE_KINDS,
  type MoveKind,
  type MovesSelection,
} from "@/domain/holdings"
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

// The kind a URL without one shows.
const DEFAULT_KIND: MoveKind = "daily"

export interface HolderMovesSearch {
  // Absent for DEFAULT_KIND.
  readonly kind?: MoveKind | undefined
  // Daily's trading day; absent for the newest parsed.
  readonly day?: WibDate | undefined
  // Monthly's above-1% month; absent for the newest parsed.
  readonly month?: Month | undefined
  readonly move?: MoveParam | undefined
  // As typed; absent when empty.
  readonly q?: string | undefined
}

const field = <S extends Schema.Decoder<unknown>>(schema: S, raw: unknown) =>
  Effect.sync((): S["Type"] | undefined =>
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
  return {
    ...(yield* kindSearch((yield* field(KindParam, raw.kind)) ?? DEFAULT_KIND)),
    day: yield* field(WibDate, raw.day),
    month: yield* field(Month, raw.month),
    move: yield* field(MoveParam, raw.move),
    q: q === "" ? undefined : q,
  }
})

// The search that shows `kind`, keeping each kind's period.
export const kindSearch = (kind: MoveKind) =>
  Effect.succeed<HolderMovesSearch>({
    kind: kind === DEFAULT_KIND ? undefined : kind,
  })

// Each kind's period as the URL spells it: the selection a search makes,
// and the search that picks a period's data date, or the newest.
const PERIODS: {
  readonly [K in MoveKind]: {
    readonly selection: (
      search: HolderMovesSearch
    ) => Effect.Effect<Extract<MovesSelection, { readonly kind: K }>>
    readonly search: (
      period: WibDate | undefined
    ) => Effect.Effect<HolderMovesSearch>
  }
} = {
  daily: {
    selection: ({ day }) => Effect.succeed({ kind: "daily", day }),
    search: (day) => Effect.succeed({ day }),
  },
  monthly: {
    selection: ({ month }) => Effect.succeed({ kind: "monthly", month }),
    search: (period) =>
      period === undefined
        ? Effect.succeed({ month: undefined })
        : Effect.map(monthOf(period), (month) => ({ month })),
  },
}

// The kind and its period the search selects.
export const selectionOf = (
  search: HolderMovesSearch
): Effect.Effect<MovesSelection> =>
  PERIODS[search.kind ?? DEFAULT_KIND].selection(search)

// The search that picks `period` of `kind`, left out when it is the newest
// of `periods`.
export const periodSearch = (
  kind: MoveKind,
  period: WibDate,
  periods: ReadonlyArray<WibDate>
) => PERIODS[kind].search(period === periods.at(-1) ? undefined : period)

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
