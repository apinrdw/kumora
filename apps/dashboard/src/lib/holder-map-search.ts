// What /holder-map reads from its URL (spec apinrdw/kumora#733, "Route"):
// the focus and the as-of trading day, each left out when absent, so a plain
// link opens the landing view on the newest day.
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import type { HolderMapQuery, MoveKind } from "@/domain/holdings"

export interface HolderMapSearch {
  // The focus stock; absent for the landing view.
  readonly stock?: StockCode | undefined
  // The as-of trading day; absent for the newest parsed.
  readonly day?: WibDate | undefined
}

const field = <S extends Schema.Decoder<unknown>>(schema: S, raw: unknown) =>
  Effect.sync((): S["Type"] | undefined =>
    Option.getOrUndefined(Schema.decodeUnknownOption(schema)(raw))
  )

/**
 * Keeps the fields that parse and drops anything else; a stock code as
 * typed in any case. A dropped one is set `undefined`: the router lays the
 * validated search over the raw one, which would keep it.
 */
export const parseHolderMapSearch = Effect.fnUntraced(function* (
  raw: Record<string, unknown>
): Effect.fn.Return<HolderMapSearch> {
  return {
    stock: yield* field(
      StockCode,
      typeof raw.stock === "string" ? raw.stock.toUpperCase() : raw.stock
    ),
    day: yield* field(WibDate, raw.day),
  }
})

/**
 * Where a Holder moves row opens the map (spec apinrdw/kumora#733, "Links
 * in"): its stock, as of the row's day for a Daily row; a Monthly row's month
 * isn't a trading day, so it opens the newest.
 */
export const holderMapMoveSearch = (
  kind: MoveKind,
  stock: StockCode,
  period: WibDate
) =>
  Effect.succeed<HolderMapSearch>(
    kind === "daily" ? { stock, day: period } : { stock }
  )

export const queryOf = ({ stock, day }: HolderMapSearch) =>
  Effect.succeed<HolderMapQuery>({
    focus: stock === undefined ? undefined : { kind: "stock", code: stock },
    day,
  })
