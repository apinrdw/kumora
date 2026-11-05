import { Schema } from "effect"

import { SYMBOL_PATTERN } from "./symbol-guard"

/** The four-letter IDX stock code, e.g. BBCA. */
export const Symbol = Schema.String.pipe(
  Schema.check(Schema.isPattern(SYMBOL_PATTERN)),
  Schema.brand("Symbol")
)
export type Symbol = typeof Symbol.Type

export const SECTORS = [
  "Keuangan",
  "Infrastruktur",
  "Energi",
  "Logam",
  "Industri",
  "Teknologi",
] as const
export const Sector = Schema.Literals(SECTORS)
export type Sector = typeof Sector.Type

export const Liquidity = Schema.Literals(["tinggi", "sedang"])
export type Liquidity = typeof Liquidity.Type
