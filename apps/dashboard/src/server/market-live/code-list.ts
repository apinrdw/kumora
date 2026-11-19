// The trading day's stock code list (spec apinrdw/kumora#138, "Recorded day
// loads"): the relay sends Ajaib's raw list response once a day; the object
// stores it normalised and serves it to the page with one GET.
import {
  INDICES,
  decodeAjaibCodeList,
  decodeStockCodeList,
  encodeStockCodeList,
  kindOf,
  wibDateAt,
  wibDayEnd,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect, Option } from "effect"

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

// Decision: an encoded list over 2 MB is dropped with a log. Ajaib's codes
// encode to about 0.2 MB, so ten times that is a wrong answer rather than a
// list that grew, and the cap keeps the value well under the Durable Object's
// 8 MB per key and value. See apinrdw/kumora#157.
const MAX_STORED_BYTES = 2_000_000

// Normalises Ajaib's body, adds the indices, which Ajaib doesn't list, and
// stores it, replacing the day's earlier list. A body that doesn't parse is
// logged and dropped: the relay keeps relaying.
export const storeCodeList = Effect.fnUntraced(
  function* (store: CodeListStore, body: string) {
    const listed = yield* decodeAjaibCodeList(body)
    const codes = yield* Effect.forEach(listed, (entry) =>
      Effect.map(kindOf(entry.code), (kind) => ({ ...entry, kind }))
    )
    const text = yield* encodeStockCodeList({
      codes: [
        ...codes,
        ...INDICES.map((index) => ({ ...index, kind: "index" as const })),
      ],
    })
    if (new TextEncoder().encode(text).length > MAX_STORED_BYTES)
      return yield* Effect.logWarning("Stock code list too large; dropped")
    yield* store.write(text)
  },
  Effect.catchTag("SchemaError", (error) =>
    Effect.logWarning("Stock code list not understood; dropped", error)
  )
)

// The codes the day's stored list names; none while it holds no list.
export const listedCodes = Effect.fnUntraced(function* (store: CodeListStore) {
  const stored = yield* store.read
  if (Option.isNone(stored)) return undefined
  const { codes } = yield* decodeStockCodeList(stored.value).pipe(Effect.orDie)
  return new Set(codes.map((listed) => listed.code))
})

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
  const nextDay = DateTime.toEpochMillis(yield* wibDayEnd(today))
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
