// This browser's alert rules, chime and today's alert history (spec
// apinrdw/kumora#517, "Alerts"), outside React, plus whether the bell is
// open, so an alert's View on any page can open it.
import { clientRuntime, StockCode } from "@workspace/client"
import { BookEventSide, WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"
import { useSyncExternalStore } from "react"

import {
  MIN_VALUES,
  type AlertHistory,
  type AlertRule,
} from "@/lib/book-alerts"

const Kind = Schema.Literals([
  "absorbed",
  "eaten",
  "reloaded",
  "appeared",
  "pulled",
  "moved",
])

const Rules = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    kinds: Schema.Array(Kind),
    scope: Schema.Union([
      Schema.TaggedStruct("watchlist", {}),
      Schema.TaggedStruct("codes", { codes: Schema.Array(StockCode) }),
      Schema.TaggedStruct("scanner", {}),
    ]),
    minValue: Schema.Literals(MIN_VALUES),
  })
)

const History = Schema.Struct({
  day: WibDate,
  alerts: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      code: StockCode,
      side: BookEventSide,
      title: Schema.String,
      detail: Schema.String,
      at: Schema.Finite,
    })
  ),
})

export interface Stored<A> {
  readonly fallback: A
  readonly get: () => A
  readonly set: (value: A) => void
  readonly subscribe: (listener: () => void) => () => void
}

// One localStorage key holding a value of `schema`; anything else stored
// reads as `fallback`. Storage blocked: a change lasts as long as the page.
// Another tab's change is seen too: both tabs alert into the same history.
const stored = <A>(
  key: string,
  schema: Schema.Codec<A, unknown>,
  fallback: A
): Stored<A> => {
  const parse = Schema.decodeUnknownOption(Schema.fromJsonString(schema))
  const encode = Schema.encodeSync(Schema.fromJsonString(schema))
  const read = Effect.try(() => window.localStorage.getItem(key)).pipe(
    Effect.orElseSucceed(() => null)
  )
  let cached: { raw: string | null; value: A } = { raw: null, value: fallback }
  let unstored: { value: A } | undefined
  const listeners = new Set<() => void>()
  const get = () => {
    if (unstored !== undefined) return unstored.value
    const raw = clientRuntime.runSync(read)
    if (raw !== cached.raw)
      cached = {
        raw,
        value:
          raw === null
            ? fallback
            : Option.getOrElse(parse(raw), () => fallback),
      }
    return cached.value
  }
  return {
    fallback,
    get,
    set: (value) => {
      clientRuntime.runSync(
        Effect.try(() => window.localStorage.setItem(key, encode(value))).pipe(
          Effect.orElseSucceed(() => {
            unstored = { value }
          })
        )
      )
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      window.addEventListener("storage", listener)
      return () => {
        listeners.delete(listener)
        window.removeEventListener("storage", listener)
      }
    },
  }
}

// Decision: rules, the chime and the history are each browser's own, in
// localStorage, like the watchlist (use-watchlist.ts). See spec
// apinrdw/kumora#517, "Alerts".
const NO_RULES: ReadonlyArray<AlertRule> = []
export const alertRules: Stored<ReadonlyArray<AlertRule>> = stored(
  "kumora:book-alerts:rules",
  Rules,
  NO_RULES
)

export const alertChime: Stored<boolean> = stored(
  "kumora:book-alerts:chime",
  Schema.Boolean,
  false
)

const NO_HISTORY: AlertHistory = {
  day: WibDate.make("1970-01-01"),
  alerts: [],
}
export const alertHistory: Stored<AlertHistory> = stored(
  "kumora:book-alerts:history",
  History,
  NO_HISTORY
)

// A value in memory only.
const held = <A>(fallback: A): Stored<A> => {
  let value = fallback
  const listeners = new Set<() => void>()
  return {
    fallback,
    get: () => value,
    set: (next) => {
      if (next === value) return
      value = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

// Whether the Alerts bell is open, so a View on another page opens it.
export const alertBell = held(false)

// Today on the trading-day object's clock, from its last message: the bell
// shows this day's alerts. None before the first message.
export const alertDay = held<WibDate | undefined>(undefined)

// A stored value in React; the server render has its fallback.
export function useStored<A>(store: Stored<A>) {
  return useSyncExternalStore(store.subscribe, store.get, () => store.fallback)
}
