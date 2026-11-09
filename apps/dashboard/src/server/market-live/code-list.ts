// The trading day's stock code list (spec apinrdw/kumora#138, "Recorded day
// loads"): the relay sends Ajaib's raw list response once a day; the object
// stores it normalised and serves it to the page with one GET.
import {
  INDICES,
  StockCode,
  encodeStockCodeList,
  wibDateAt,
  type CodeKind,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Option, Schema } from "effect"

import { SEALED_CACHE } from "./routes.ts"

// Where the object keeps the list: one stored value, the encoded list.
export interface CodeListStore {
  readonly read: Effect.Effect<Option.Option<string>>
  readonly write: (text: string) => Effect.Effect<void>
}

// A store that lasts as long as the trading day: for tests, and for a caller
// with no storage.
export const memoryCodeListStore = Effect.sync((): CodeListStore => {
  let stored = Option.none<string>()
  return {
    read: Effect.sync(() => stored),
    write: (text) =>
      Effect.sync(() => {
        stored = Option.some(text)
      }),
  }
})

// Ajaib's `/stock/data/list/` body, as the 2026-11-09 probe recorded it.
const AjaibList = Schema.fromJsonString(
  Schema.Struct({
    results: Schema.Array(
      Schema.Struct({ code: Schema.String, name: Schema.NullOr(Schema.String) })
    ),
  })
)

// Decision: the kind comes from the suffix alone, as the spec says: `-W` and
// `-W2` are warrants, `-R` rights. Ajaib's structured warrants (`BBRIDRCM3A`)
// and funds (`R-LQ45X`) stay shares.
const kindOf = (code: string): CodeKind =>
  /-W\d*$/.test(code) ? "warrant" : /-R\d*$/.test(code) ? "right" : "share"

// Decision: an encoded list over 2 MB, the most one stored value holds, is
// dropped with a log. Ajaib's 3,406 codes encode to about 0.2 MB.
const MAX_STORED_BYTES = 2_000_000

// Normalises Ajaib's body, adds the indices, which Ajaib doesn't list, and
// stores it, replacing the day's earlier list. A body that doesn't parse is
// logged and dropped: the relay keeps relaying.
export const storeCodeList = Effect.fnUntraced(
  function* (store: CodeListStore, body: string) {
    const { results } = yield* Schema.decodeUnknownEffect(AjaibList)(body)
    const text = yield* encodeStockCodeList({
      codes: results
        .filter(({ code }) => code !== "")
        .map(({ code, name }) => ({
          code: StockCode.make(code),
          name: name ?? "",
          kind: kindOf(code),
        }))
        .concat(INDICES.map((index) => ({ ...index, kind: "index" as const }))),
    })
    if (new TextEncoder().encode(text).length > MAX_STORED_BYTES)
      return yield* Effect.logWarning("Stock code list too large; dropped")
    yield* store.write(text)
  },
  Effect.catchTag("SchemaError", (error) =>
    Effect.logWarning("Stock code list not understood; dropped", error)
  )
)

// The GET's answer. A past day's list never changes; today's is cached until
// the next WIB day; a day with no list yet answers 404, not cached.
export const codeListAnswer = Effect.fnUntraced(function* (
  store: CodeListStore,
  date: WibDate
) {
  const stored = yield* store.read
  if (Option.isNone(stored))
    return new Response("No stock code list for this day", {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    })
  const now = yield* DateTime.now
  const today = yield* wibDateAt(now)
  const nextDay = Date.parse(`${today}T00:00:00+07:00`) + 86_400_000
  const cacheControl =
    date < today
      ? SEALED_CACHE
      : `private, max-age=${Math.ceil((nextDay - DateTime.toEpochMillis(now)) / 1000)}`
  return new Response(stored.value, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    },
  })
})
