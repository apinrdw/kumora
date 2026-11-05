import { Schema } from "effect"

import { Symbol } from "@/domain/symbol"

/** A service was asked for a well-formed Symbol it has no data for. */
export class SymbolNotFound extends Schema.TaggedError<SymbolNotFound>()(
  "SymbolNotFound",
  { symbol: Symbol }
) {}
