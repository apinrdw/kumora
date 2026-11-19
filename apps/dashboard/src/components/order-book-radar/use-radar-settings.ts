import { clientRuntime } from "@workspace/client"
import { Effect, Schema, SchemaGetter } from "effect"
import { useCallback, useSyncExternalStore } from "react"

import {
  DEFAULT_SETTINGS,
  FLOORS,
  RANK_CHOICES,
  type RadarSettings,
  type RankKey,
} from "@/lib/order-book-radar"
import { makeSchemaStoredValue } from "@/lib/stored-value"

// Decision: like the watchlist (use-watchlist.ts), each browser keeps its
// own value floor, filters and Rank by in localStorage. See spec
// apinrdw/kumora#517, "The scanner".
const KEY = "kumora:order-book-radar:settings"

const Price = Schema.UndefinedOr(Schema.Finite.check(Schema.isGreaterThan(0)))

const RANK_KEYS = RANK_CHOICES.map((choice) => choice.value)

// Decision: Rank by's near depth choices were stored as bidDepth and
// offerDepth before they took the glossary's name, Near depth; a browser
// that kept one reads it as the new key, and the next change stores that.
const RENAMED_RANK_KEYS = {
  bidDepth: "bidNearDepth",
  offerDepth: "offerNearDepth",
} as const satisfies Record<string, RankKey>

const RankBy = Schema.Literals([...RANK_KEYS, "bidDepth", "offerDepth"]).pipe(
  Schema.decodeTo(Schema.Literals(RANK_KEYS), {
    decode: SchemaGetter.transform((key) =>
      key === "bidDepth" || key === "offerDepth" ? RENAMED_RANK_KEYS[key] : key
    ),
    encode: SchemaGetter.transform((key) => key),
  })
)

const Stored = Schema.Struct({
  floor: Schema.Literals(FLOORS),
  codes: Schema.Literals(["all", "watchlist"]),
  search: Schema.String,
  priceMin: Schema.optionalKey(Price),
  priceMax: Schema.optionalKey(Price),
  rankBy: RankBy,
  direction: Schema.Literals(["high", "low"]),
})

// Storage blocked, or anything else stored, reads as the defaults. This
// tab's changes only: another tab's settings are its own.
const { subscribe, snapshot, write } = Effect.runSync(
  makeSchemaStoredValue({
    key: KEY,
    schema: Stored,
    fallback: DEFAULT_SETTINGS,
    crossTab: false,
  })
)

// This browser's scanner settings and their change. The server render has
// the defaults.
export function useRadarSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    snapshot,
    () => DEFAULT_SETTINGS
  )
  const change = useCallback(
    (patch: Partial<RadarSettings>) =>
      clientRuntime.runSync(write({ ...snapshot(), ...patch })),
    []
  )
  return { settings, change }
}
