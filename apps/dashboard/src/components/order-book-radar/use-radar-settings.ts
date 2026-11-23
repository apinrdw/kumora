import { clientRuntime } from "@workspace/client"
import { Effect, Schema, SchemaGetter } from "effect"
import { useCallback, useSyncExternalStore } from "react"

import {
  DEFAULT_SETTINGS,
  FLOORS,
  HEAVY_SIDE_FILTERS,
  RANK_CHOICES,
  type RadarSettings,
  type RankKey,
} from "@/lib/order-book-radar"
import { makeSchemaStoredValue } from "@/lib/stored-value"

// Decision: each browser keeps its own settings in localStorage
// (apps/dashboard/docs/adr/0021-each-browser-keeps-its-own-settings-in-localstorage.md)
const KEY = "kumora:order-book-radar:settings"

const Price = Schema.UndefinedOr(Schema.Finite.check(Schema.isGreaterThan(0)))

const RANK_KEYS = RANK_CHOICES.map((choice) => choice.value)

// Decision: an option the scanner dropped reads as its default, keeping the rest
// (apps/dashboard/docs/adr/0022-radar-settings-stored-under-an-older-shape-read-as-defaults.md)
const REMOVED_RANK_KEYS = [
  "bidDepth",
  "offerDepth",
  "bidNearDepth",
  "offerNearDepth",
  "emptyTicks",
  "spread",
] as const

const RankKeys = Schema.Literals(RANK_KEYS)
const isRankKey = Schema.is(RankKeys)

const RankBy = Schema.Literals([...RANK_KEYS, ...REMOVED_RANK_KEYS]).pipe(
  Schema.decodeTo(RankKeys, {
    decode: SchemaGetter.transform((key): RankKey =>
      isRankKey(key) ? key : "imbalance"
    ),
    encode: SchemaGetter.transform((key) => key),
  })
)

// Decision: an option the scanner dropped reads as its default, keeping the rest
// (apps/dashboard/docs/adr/0022-radar-settings-stored-under-an-older-shape-read-as-defaults.md)
const HeavySide = Schema.Literals(HEAVY_SIDE_FILTERS).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed("any" as const))
)

const Stored = Schema.Struct({
  floor: Schema.Literals(FLOORS),
  codes: Schema.Literals(["all", "watchlist"]),
  search: Schema.String,
  priceMin: Schema.optionalKey(Price),
  priceMax: Schema.optionalKey(Price),
  heavySide: HeavySide,
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
