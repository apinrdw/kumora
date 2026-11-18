import { clientRuntime } from "@workspace/client"
import { Effect } from "effect"
import { useCallback, useEffect, useSyncExternalStore } from "react"

import {
  CHART_SETTINGS_DEFAULT,
  parseChartSettings,
  type ChartSettings,
  type ChartZooms,
} from "@/lib/chart-settings"
import { jsonText, makeStoredValue } from "@/lib/stored-value"

import type { SweepStore } from "./sweep-store"

// Decision: like the watchlist (use-watchlist.ts), each browser keeps its
// own chart settings in localStorage under one key (spec apinrdw/kumora#263,
// "Settings"). The e2e reloads to read them back
// (apps/e2e/tests/market-live-footprint-controls.spec.ts).
const KEY = "kumora:market-live:charts"

// Storage blocked reads as nothing stored: the defaults.
const { subscribe, snapshot, write } = Effect.runSync(
  makeStoredValue<ChartSettings>({
    key: KEY,
    parse: parseChartSettings,
    serialize: jsonText,
  })
)

// This browser's chart settings and a change to some of them. The server
// render has the defaults.
export function useChartSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    snapshot,
    () => CHART_SETTINGS_DEFAULT
  )
  const change = useCallback(
    (patch: Partial<ChartSettings>) =>
      clientRuntime.runSync(write({ ...snapshot(), ...patch })),
    []
  )
  return { settings, change }
}

// `chart`'s saved zoom: a chart reads it once, when it is made, and from then
// on keeps its own.
export const savedZoom = <K extends keyof ChartZooms>(chart: K) =>
  snapshot().zoom[chart]

// Saves `change` into `chart`'s zoom; a field set to undefined goes back to
// the default.
export const saveZoom = <K extends keyof ChartZooms>(
  chart: K,
  change: ChartZooms[K]
) => {
  const settings = snapshot()
  clientRuntime.runSync(
    write({
      ...settings,
      zoom: {
        ...settings.zoom,
        [chart]: { ...settings.zoom[chart], ...change },
      },
    })
  )
}

// The candle chart's top-N, remembered: the code's sweep store opens on the
// saved percent, and each change the control makes is saved.
export function useRememberedTopN(sweeps: SweepStore) {
  const { settings, change } = useChartSettings()
  useEffect(() => sweeps.setTopN(settings.topN), [sweeps, settings.topN])
  useEffect(
    () =>
      sweeps.subscribe((event) => {
        if (event._tag === "TopN") change({ topN: sweeps.topN() })
      }),
    [sweeps, change]
  )
}
