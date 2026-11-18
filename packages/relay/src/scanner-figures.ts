// What the order book radar's scanner filters a code by besides its book
// readings (spec apinrdw/kumora#517, "The scanner"): its last price for the
// price band, its previous close for the Rp1–10 exclusion, and its
// regular-board value on the previous trading day for the value floor.
import { Schema, SchemaGetter } from "effect"

import { StockCode } from "./codes.ts"

// None when the object doesn't know it: no Day state yet, no previous close
// carried, or no previous day's value (the first day after a gap).
const ScannerFiguresFields = Schema.Struct({
  code: StockCode,
  last: Schema.UndefinedOr(Schema.Finite),
  previousClose: Schema.UndefinedOr(Schema.Finite),
  previousValue: Schema.UndefinedOr(Schema.Finite),
})

// Decision: a code's figures travel as a tuple, [code, last, previous close,
// previous value], none as null: a snapshot carries one for every code with
// readings, about 900 on a busy day. The previous value is rounded to the
// rupiah.
export const ScannerFigures = Schema.Tuple([
  StockCode,
  Schema.NullOr(Schema.Finite),
  Schema.NullOr(Schema.Finite),
  Schema.NullOr(Schema.Finite),
]).pipe(
  Schema.decodeTo(Schema.toType(ScannerFiguresFields), {
    decode: SchemaGetter.transform(
      ([code, last, previousClose, previousValue]) => ({
        code,
        last: last ?? undefined,
        previousClose: previousClose ?? undefined,
        previousValue: previousValue ?? undefined,
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
        ] as const
    ),
  })
)
export type ScannerFigures = typeof ScannerFigures.Type
