// One search param as a route's `validateSearch` parses it: Holder moves'
// (holder-moves-search.ts) and the Holder map's (holder-map-search.ts).
import { Effect, Option, Schema } from "effect"

// `raw` parsed by `schema`, undefined when it doesn't parse.
export const field = <S extends Schema.Decoder<unknown>>(
  schema: S,
  raw: unknown
) =>
  Effect.sync((): S["Type"] | undefined =>
    Option.getOrUndefined(Schema.decodeUnknownOption(schema)(raw))
  )
