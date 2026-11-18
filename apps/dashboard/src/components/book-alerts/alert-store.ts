// This browser's alert rules, chime and today's alert history (spec
// apinrdw/kumora#517, "Alerts"), outside React, plus whether the bell is
// open, so an alert's View on any page can open it.
import { clientRuntime, StockCode } from "@workspace/client"
import { BookEventSide, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"
import { useSyncExternalStore } from "react"

import {
  MIN_VALUES,
  NO_LIMITS,
  type AlertHistory,
  type AlertLimits,
  type AlertRule,
} from "@/lib/book-alerts"
import { makeSchemaStoredValue } from "@/lib/stored-value"

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
): Effect.Effect<Stored<A>> =>
  Effect.map(makeSchemaStoredValue({ key, schema, fallback }), (value) => ({
    fallback,
    get: value.snapshot,
    set: (next) => clientRuntime.runSync(value.write(next)),
    subscribe: value.subscribe,
  }))

// Decision: rules, the chime and the history are each browser's own, in
// localStorage, like the watchlist (use-watchlist.ts). See spec
// apinrdw/kumora#517, "Alerts".
const NO_RULES: ReadonlyArray<AlertRule> = []
export const alertRules: Stored<ReadonlyArray<AlertRule>> = Effect.runSync(
  stored("kumora:book-alerts:rules", Rules, NO_RULES)
)

export const alertChime: Stored<boolean> = Effect.runSync(
  stored("kumora:book-alerts:chime", Schema.Boolean, false)
)

const NO_HISTORY: AlertHistory = {
  day: WibDate.make("1970-01-01"),
  alerts: [],
}
export const alertHistory: Stored<AlertHistory> = Effect.runSync(
  stored("kumora:book-alerts:history", History, NO_HISTORY)
)

const Limits = Schema.Struct({
  last: Schema.Record(Schema.String, Schema.Finite),
  shown: Schema.Array(Schema.Finite),
  fold: Schema.NullOr(
    Schema.Struct({ since: Schema.Finite, count: Schema.Finite })
  ),
})

// The browser's alert rate limit so far, read and written only under its
// lock (use-book-alerts.ts).
export const alertLimits: Stored<AlertLimits> = Effect.runSync(
  stored("kumora:book-alerts:limits", Limits, NO_LIMITS)
)

// A value in memory only.
const held = <A>(fallback: A) =>
  Effect.sync((): Stored<A> => {
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
  })

// Whether the Alerts bell is open, so a View on another page opens it.
export const alertBell = Effect.runSync(held(false))

// Today on the trading-day object's clock, from its last message: the bell
// shows this day's alerts. None before the first message.
export const alertDay = Effect.runSync(held<WibDate | undefined>(undefined))

// A stored value in React; the server render has its fallback.
export function useStored<A>(store: Stored<A>) {
  return useSyncExternalStore(store.subscribe, store.get, () => store.fallback)
}
