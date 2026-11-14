// Chart 2's two-line header (spec apinrdw/kumora#263, "Header readout"): the
// hovered minute's figures, else the cursor's (live: the latest minute's).
// The canvas tells it both.
import { Effect } from "effect"
import { useMemo, useSyncExternalStore } from "react"

import type { FootprintColumn } from "@/lib/footprint"
import { footprintHeader, type HeaderTone } from "@/lib/footprint-header"

export interface HeaderStore {
  // The minute the cursor is on, none before any.
  readonly show: (column: FootprintColumn | undefined) => void
  // The minute under the pointer, none when off the chart.
  readonly hover: (column: FootprintColumn | undefined) => void
  readonly get: () => FootprintColumn | undefined
  readonly subscribe: (listener: () => void) => () => void
}

export const makeHeaderStore = (): HeaderStore => {
  let shown: FootprintColumn | undefined
  let hovered: FootprintColumn | undefined
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const listener of listeners) listener()
  }
  return {
    show: (column) => {
      if (column === shown) return
      shown = column
      if (hovered === undefined) emit()
    },
    hover: (column) => {
      if (column === hovered) return
      hovered = column
      emit()
    },
    get: () => hovered ?? shown,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}

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
