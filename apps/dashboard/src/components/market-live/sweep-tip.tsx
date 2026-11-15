// The one tooltip of chart 1's bubbles and the sweep log's broker cells
// (spec apinrdw/kumora#343, "One tooltip"): the sweep, then every broker of
// each side with its lots, uncapped. A bubble or a cell sets where it shows
// (`SweepStore.tip`); a press anywhere hides it.
import { Effect } from "effect"
import { useEffect, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"

import { lots } from "@/lib/format"
import { sweepTip } from "@/lib/sweeps"

import type { SweepStore } from "./sweep-store"
import { INVESTOR_TEXT } from "./tape-list"

// The tooltip sits this far from its point, on the side with more room.
const GAP_PX = 12

export function SweepTip({
  store,
  withBrokers,
}: {
  store: SweepStore
  // Whether the shown day can have broker codes: a recorded day.
  withBrokers: boolean
}) {
  const at = useSyncExternalStore(
    store.tip.subscribe,
    store.tip.get,
    () => undefined
  )
  const from = at?.from
  useEffect(() => {
    if (from === undefined) return
    const hide = () => store.tip.set(undefined)
    // A tap shows the next as its press lifts, after this press hid it.
    document.addEventListener("pointerdown", hide)
    // A scroll leaves a cell's tooltip behind. A bubble's stays: picking it
    // scrolls the log to its row.
    if (from === "log")
      window.addEventListener("scroll", hide, { capture: true, passive: true })
    return () => {
      document.removeEventListener("pointerdown", hide)
      window.removeEventListener("scroll", hide, { capture: true })
    }
  }, [store, from])
  if (at === undefined) return null
  const sweep = store.sweeps().find((held) => held.firstTrade === at.id)
  if (sweep === undefined) return null
  const tip = Effect.runSync(sweepTip(sweep, store.brokers().get(at.id)))
  const right = at.x > window.innerWidth / 2
  const below = at.y < window.innerHeight / 2
  return createPortal(
    <div
      role="tooltip"
      aria-label="Sweep brokers"
      className="border-strong pointer-events-none fixed z-50 max-w-[300px] min-w-[200px] rounded-md border bg-popover px-2 py-1.5 font-mono text-[11px] leading-snug tabular-nums shadow-lg"
      style={{
        ...(right
          ? { right: window.innerWidth - at.x + GAP_PX }
          : { left: at.x + GAP_PX }),
        ...(below
          ? { top: at.y + GAP_PX }
          : { bottom: window.innerHeight - at.y + GAP_PX }),
      }}
    >
      <p className="mb-1 font-sans font-semibold">{tip.title}</p>
      {tip.sides === undefined ? (
        <p className="text-muted-foreground">
          {withBrokers
            ? "Brokers show once every trade in this sweep has its codes."
            : "Broker codes arrive after the close."}
        </p>
      ) : (
        <table className="w-full border-collapse">
          <tbody>
            {tip.sides.map((side) => [
              <tr key={side.label}>
                <th
                  colSpan={2}
                  scope="colgroup"
                  className="pt-1 text-left font-sans text-[10px] font-normal tracking-[0.06em] text-muted-foreground uppercase"
                >
                  {side.label}
                </th>
              </tr>,
              ...side.brokers.map((broker) => (
                <tr key={`${side.label} ${broker.code}`}>
                  <td className={INVESTOR_TEXT[broker.investorType]}>
                    {broker.code} [{broker.investorType}]
                  </td>
                  <td className="text-right">
                    {Effect.runSync(lots(broker.lots))}
                  </td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      )}
    </div>,
    document.body
  )
}
