import { clientRuntime } from "@workspace/client"
import { Effect, Option, Schema } from "effect"
import { useCallback, useSyncExternalStore } from "react"

import {
  DEFAULT_SETTINGS,
  FLOORS,
  RANK_CHOICES,
  type RadarSettings,
} from "@/lib/order-book-radar"

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

const parse = Schema.decodeUnknownOption(Schema.fromJsonString(Stored))

const settingsOf = (raw: string | null): RadarSettings =>
  Option.match(raw === null ? Option.none() : parse(raw), {
    onNone: () => DEFAULT_SETTINGS,
    onSome: (stored) => ({
      ...stored,
      priceMin: stored.priceMin,
      priceMax: stored.priceMax,
    }),
  })

// Storage blocked reads as nothing stored: the defaults.
const read = Effect.try(() => window.localStorage.getItem(KEY)).pipe(
  Effect.orElseSucceed(() => null)
)

// The settings as last read, kept while the stored text is unchanged, so
// React sees the same object; changed while storage is blocked, they last
// as long as the page.
let cached: { raw: string | null; settings: RadarSettings } = {
  raw: null,
  settings: DEFAULT_SETTINGS,
}
let unstored: RadarSettings | undefined
const snapshot = () => {
  if (unstored !== undefined) return unstored
  const raw = clientRuntime.runSync(read)
  if (raw !== cached.raw) cached = { raw, settings: settingsOf(raw) }
  return cached.settings
}

const listeners = new Set<() => void>()
// This tab's changes only: another tab's settings are its own.
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

const write = Effect.fnUntraced(function* (settings: RadarSettings) {
  yield* Effect.try(() =>
    window.localStorage.setItem(KEY, JSON.stringify(settings))
  ).pipe(
    Effect.orElseSucceed(() => {
      unstored = settings
    })
  )
  for (const listener of listeners) listener()
})

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
