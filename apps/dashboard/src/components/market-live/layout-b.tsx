import { cn } from "@workspace/ui/lib/utils"
import { useEffect, useId, useRef, type ReactNode } from "react"

import { PANELS, type Panel } from "@/lib/market-live-search"

// The gap kept under the layout, the page's bottom padding.
const BOTTOM_GAP = 16

// The element's minimum height runs from its top to the viewport's bottom,
// measured again on each resize, as `--fill`.
function useFillViewport<E extends HTMLElement>() {
  const ref = useRef<E>(null)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const fit = () => {
      const top = element.getBoundingClientRect().top + window.scrollY
      element.style.setProperty(
        "--fill",
        `${Math.max(0, window.innerHeight - top - BOTTOM_GAP)}px`
      )
    }
    fit()
    window.addEventListener("resize", fit)
    return () => window.removeEventListener("resize", fit)
  }, [])
  return ref
}

// Each panel's tab name on a phone.
const TAB_NAMES: Record<Panel, string> = {
  sweeps: "Sweeps",
  watchlist: "Watchlist",
  book: "Order book",
  tape: "Tape",
}

/**
 * Layout B (spec apinrdw/kumora#263, "Layout, settings, indices and
 * phone"). From `lg`: the chart column, the sweep log and the 400 px
 * right column of `watchlist`, `book` and `tape`, at least as tall as the
 * window below them. The tape scrolls sideways in it (tape-list.tsx). Below `lg`: the charts stacked full width, then tabs
 * showing one panel at a time: `panel`, kept by the page in its URL, else
 * the first. No `log` (an index): no log column or tab.
 */
export function LayoutB({
  charts,
  log,
  withBrokers,
  watchlist,
  book,
  tape,
  panel: picked,
  onPanel,
}: {
  charts: ReactNode
  log: ReactNode | undefined
  // Whether the log has its broker columns: a recorded day's.
  withBrokers: boolean
  watchlist: ReactNode
  book: ReactNode
  tape: ReactNode
  panel: Panel | undefined
  onPanel: (panel: Panel) => void
}) {
  const layout = useFillViewport<HTMLDivElement>()
  const id = useId()
  const content: Record<Panel, ReactNode> = {
    sweeps: log,
    watchlist,
    book,
    tape,
  }
  const panels = PANELS.filter((name) => content[name] !== undefined)
  const shown =
    picked !== undefined && panels.includes(picked) ? picked : panels[0]
  // Decision: a hidden tab's panel stays mounted (hidden by CSS), so the
  // tape keeps its socket and every panel its state across tab switches.
  const panel = (name: Panel, className?: string) =>
    content[name] !== undefined && (
      <div
        id={`${id}-${name}`}
        className={cn("flex min-w-0 flex-col", className, {
          "max-lg:hidden": name !== shown,
        })}
      >
        {content[name]}
      </div>
    )
  return (
    <div
      ref={layout}
      className={cn(
        "grid gap-4 lg:min-h-(--fill)",
        // Decision: the sweep log is 340 px live. On a recorded day, whose
        // sweeps can have brokers, it flexes from 340 px up to 530 px and
        // gives way first: the charts keep 480 px, or all the room the 340
        // px log and the 400 px column leave when that is less (772 px is
        // those two and the grid's two 16 px gaps). Narrower than its broker
        // columns, the log scrolls them sideways (sweep-log.tsx). Live the
        // columns would stay blank, so the charts keep the room. See spec
        // apinrdw/kumora#343, "Log layout A".
        log === undefined
          ? "lg:grid-cols-[minmax(0,1fr)_400px]"
          : withBrokers
            ? "lg:grid-cols-[minmax(min(480px,calc(100%-772px)),1fr)_minmax(340px,530px)_400px]"
            : "lg:grid-cols-[minmax(0,1fr)_340px_400px]"
      )}
    >
      <div className="flex min-w-0 flex-col gap-4">{charts}</div>
      <div
        role="tablist"
        aria-label="Panels"
        className="flex gap-0.5 rounded-md border border-border bg-sidebar p-0.5 text-[13px] lg:hidden"
      >
        {panels.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={name === shown}
            aria-controls={`${id}-${name}`}
            onClick={() => onPanel(name)}
            className={cn(
              "flex-1 rounded-sm px-2 py-1",
              name === shown
                ? "bg-elevated text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {TAB_NAMES[name]}
          </button>
        ))}
      </div>
      {panel("sweeps", "*:flex-1")}
      {/* Below `lg` its panels are the grid's own rows, under the tabs. */}
      <div className="min-w-0 max-lg:contents lg:flex lg:flex-col lg:gap-4">
        {panel("watchlist")}
        {panel("book")}
        {panel("tape")}
      </div>
    </div>
  )
}
