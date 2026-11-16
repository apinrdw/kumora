// The footprint chart's hover ladder (spec apinrdw/kumora#263, "Hover ladder"):
// over the chart, beside the pointer, the hovered minute's exact sell, price
// and buy per level, then Vol, Δ and CVD. The canvas sets what is hovered.
import { useSyncExternalStore } from "react"

import type { Ladder } from "@/lib/footprint-ladder"

import type { ListenerStore } from "./listener-store"

// What the ladder shows: a minute's ladder at the pointer (CSS px in the
// chart), or nothing.
export type Hovered =
  | {
      readonly ladder: Ladder
      readonly x: number
      readonly y: number
      readonly width: number
    }
  | undefined

export type LadderStore = ListenerStore<Hovered>

const TONE = {
  up: "text-up",
  down: "text-down",
  flat: "",
} as const

// The ladder sits this far from the pointer, on the side with more room.
const GAP_PX = 16

export function FootprintLadder({ store }: { store: LadderStore }) {
  const hovered = useSyncExternalStore(
    store.subscribe,
    store.get,
    () => undefined
  )
  if (hovered === undefined) return null
  const { ladder, x, y, width } = hovered
  const left = x < width / 2
  return (
    <div
      role="tooltip"
      aria-label="Footprint ladder"
      className="border-strong pointer-events-none absolute z-10 -translate-y-1/2 rounded-md border bg-popover px-2 py-1.5 font-mono text-[11px] leading-snug tabular-nums shadow-lg"
      style={{
        top: y,
        ...(left ? { left: x + GAP_PX } : { right: width - x + GAP_PX }),
      }}
    >
      <p className="mb-1 text-muted-foreground">{ladder.title}</p>
      <table className="border-collapse">
        <tbody>
          {ladder.rows.map((row) => (
            <tr
              key={row.price}
              data-here={row.here || undefined}
              className={row.here ? "bg-selected" : undefined}
            >
              <td className="text-down px-1.5 text-right">{row.sell}</td>
              <td className="text-secondary-text px-1.5 text-center">
                {row.price}
              </td>
              <td className="text-up px-1.5 text-left">{row.buy}</td>
              <td className="pl-1 text-muted-foreground">{row.none}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="mt-1 w-full border-collapse border-t border-border">
        <tbody>
          {ladder.totals.map(([label, value, tone]) => (
            <tr key={label}>
              <th
                scope="row"
                className="pr-2 text-left font-normal text-muted-foreground"
              >
                {label}
              </th>
              <td className={`text-right ${TONE[tone]}`}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
