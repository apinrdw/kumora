// What the order book radar's scanner filters a code by besides its book
// readings (spec apinrdw/kumora#517, "The scanner"): its last price for the
// price band, its previous close for the Rp1–10 exclusion, and its
// regular-board value today and on the previous trading day for the value
// floor.
import { Schema, SchemaGetter } from "effect"

import { StockCode } from "./codes.ts"

// None when the object doesn't know it: no price from either feed or a
// trade yet, no previous close carried, or no previous day's value (the
// first day after a gap). The value today is 0 before its first settled
// regular-board trade.
const ScannerFiguresFields = Schema.Struct({
  code: StockCode,
  last: Schema.UndefinedOr(Schema.Finite),
  previousClose: Schema.UndefinedOr(Schema.Finite),
  previousValue: Schema.UndefinedOr(Schema.Finite),
  value: Schema.Finite,
})

// Decision: a code's scanner figures travel as a tuple, none as null
// (packages/relay/docs/adr/0026-scanner-figures-travel-as-a-tuple.md)
export const ScannerFigures = Schema.Tuple([
  StockCode,
  Schema.NullOr(Schema.Finite),
  Schema.NullOr(Schema.Finite),
  Schema.NullOr(Schema.Finite),
  Schema.Finite,
]).pipe(
  Schema.decodeTo(Schema.toType(ScannerFiguresFields), {
    decode: SchemaGetter.transform(
      ([code, last, previousClose, previousValue, value]) => ({
        code,
        last: last ?? undefined,
        previousClose: previousClose ?? undefined,
        previousValue: previousValue ?? undefined,
        value,
      })
    ),
    encode: SchemaGetter.transform(
      (figures) =>
        [
          figures.code,
          figures.last ?? null,
          figures.previousClose ?? null,
          figures.previousValue === undefined
            ? null
            : Math.round(figures.previousValue),
          Math.round(figures.value),
        ] as const
    ),
  })
)
export type ScannerFigures = typeof ScannerFigures.Type
