import { clientRuntime } from "@workspace/client"
import { Effect, Schema } from "effect"
import { useCallback, useSyncExternalStore } from "react"

import {
  DEFAULT_SETTINGS,
  FLOORS,
  RANK_CHOICES,
  type RadarSettings,
} from "@/lib/order-book-radar"
import { makeSchemaStoredValue } from "@/lib/stored-value"

// Decision: like the watchlist (use-watchlist.ts), each browser keeps its
// own value floor, filters and Rank by in localStorage. See spec
// apinrdw/kumora#517, "The scanner".
const KEY = "kumora:order-book-radar:settings"

const Price = Schema.UndefinedOr(Schema.Finite.check(Schema.isGreaterThan(0)))

const Stored = Schema.Struct({
  floor: Schema.Literals(FLOORS),
  codes: Schema.Literals(["all", "watchlist"]),
  search: Schema.String,
  priceMin: Schema.optionalKey(Price),
  priceMax: Schema.optionalKey(Price),
  rankBy: Schema.Literals(RANK_CHOICES.map((choice) => choice.value)),
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
