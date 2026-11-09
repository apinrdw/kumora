// The trading day's stock code list (spec apinrdw/kumora#138, "Recorded day
// loads"): every code Ajaib lists, with its name, served by a plain GET from
// that day's trading-day Durable Object. It isn't part of the snapshot.
import { Effect, Schema } from "effect"

import { StockCode } from "./codes.ts"

// Ajaib's `/stock/data/list/` answer, as the 2026-11-09 probe recorded it:
// the list under `results`, an empty entry among them, each with its name
// or none. The relay reads it for the codes, the dashboard for the list it
// serves: one definition, so a change of Ajaib's shape finds both.
const AjaibCodeList = Schema.fromJsonString(
  Schema.Struct({
    results: Schema.Array(
      Schema.Struct({ code: Schema.String, name: Schema.NullOr(Schema.String) })
    ),
  })
)

// Ajaib's listed codes, the empty entry dropped, each with its name or "".
export const decodeAjaibCodeList = Effect.fnUntraced(function* (body: string) {
  const { results } = yield* Schema.decodeUnknownEffect(AjaibCodeList)(body)
  return results
    .filter(({ code }) => code !== "")
    .map(({ code, name }) => ({ code: StockCode.make(code), name: name ?? "" }))
})

// Tagged by the code's suffix: `-W` (or `-W2`) a warrant, `-R` a right.
// Search ranks both below shares. An index is one of INDICES, which the
// object adds to Ajaib's list.
const CodeKind = Schema.Literals(["share", "index", "warrant", "right"])
export type CodeKind = typeof CodeKind.Type

const ListedCode = Schema.Struct({
  code: StockCode,
  // Empty when Ajaib lists none.
  name: Schema.String,
  kind: CodeKind,
})
export type ListedCode = typeof ListedCode.Type

const StockCodeList = Schema.Struct({ codes: Schema.Array(ListedCode) })

export const decodeStockCodeList = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StockCodeList)
)

export const encodeStockCodeList = Schema.encodeEffect(
  Schema.fromJsonString(StockCodeList)
)
