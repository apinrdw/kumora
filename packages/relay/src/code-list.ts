// The trading day's stock code list (spec apinrdw/kumora#138, "Recorded day
// loads"): every code Ajaib lists, with its name, served by a plain GET from
// that day's trading-day Durable Object. It isn't part of the snapshot.
import { Schema } from "effect"

import { StockCode } from "./codes.ts"

// Tagged by the code's suffix: `-W` (or `-W2`) a warrant, `-R` a right.
// Search ranks both below shares.
const CodeKind = Schema.Literals(["share", "warrant", "right"])
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
