// The footprint chart's two-line header (spec apinrdw/kumora#263, "Header
// readout"): the hovered minute's figures, else the cursor's (live: the latest
// minute's). The canvas tells it both.
import { Effect } from "effect"
import { useMemo, useSyncExternalStore } from "react"

import type { FootprintColumn } from "@/lib/footprint"
import { footprintHeader, type HeaderTone } from "@/lib/footprint-header"

import { makeListenerStore } from "./listener-store"

export interface HeaderStore {
  // The minute the cursor is on, none before any.
  readonly show: (column: FootprintColumn | undefined) => void
  // The minute under the pointer, none when off the chart.
  readonly hover: (column: FootprintColumn | undefined) => void
  readonly get: () => FootprintColumn | undefined
  readonly subscribe: (listener: () => void) => () => void
}

// The header reads the hovered minute, else the shown one.
export const makeHeaderStore = Effect.gen(function* () {
  const read = yield* makeListenerStore<FootprintColumn | undefined>(undefined)
  let shown: FootprintColumn | undefined
  let hovered: FootprintColumn | undefined
  return {
    show: (column) => {
      shown = column
      read.set(hovered ?? shown)
    },
    hover: (column) => {
      hovered = column
      read.set(hovered ?? shown)
    },
    get: read.get,
    subscribe: read.subscribe,
  } satisfies HeaderStore
})

const TONE: Record<HeaderTone, string> = {
  up: "text-up",
  down: "text-down",
  flat: "",
  vwap: "text-day-vwap",
  band1: "text-vwap-band-1",
  band2: "text-vwap-band-2",
  band3: "text-vwap-band-3",
}

export function FootprintHeader({ store }: { store: HeaderStore }) {
  const column = useSyncExternalStore(
    store.subscribe,
    store.get,
    () => undefined
  )
  const lines = useMemo(
    () => (column === undefined ? [] : Effect.runSync(footprintHeader(column))),
    [column]
  )
  return (
    <div
      aria-label="Footprint minute"
      role="group"
      className="min-h-[34px] text-[11px] leading-[17px] text-muted-foreground tabular-nums"
    >
      {lines.map((line) => (
        <p key={line[0]?.text} className="flex flex-wrap gap-x-3">
          {line.map((part) => (
            <span key={part.text} className={TONE[part.tone]}>
              {part.text}
            </span>
          ))}
        </p>
      ))}
    </div>
  )
}
