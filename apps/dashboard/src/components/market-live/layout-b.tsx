import { cn } from "@workspace/ui/lib/utils"
import { useEffect, useId, useRef, useState, type ReactNode } from "react"

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

// The panels beside the charts on desktop, and under them as tabs on a phone.
const PANELS = ["Sweeps", "Watchlist", "Order book", "Tape"] as const
type Panel = (typeof PANELS)[number]

/**
 * Layout B (spec apinrdw/kumora#263, "Layout, settings, indices and
 * phone"). From `lg`: the chart column, the 340 px sweep log and the 400 px
 * right column of `watchlist`, `book` and `tape`, at least as tall as the
 * window below them. Below `lg`: the charts stacked full width, then tabs
 * showing one panel at a time. No `log` (an index): no log column or tab.
 */
export function LayoutB({
  charts,
  log,
  watchlist,
  book,
  tape,
}: {
  charts: ReactNode
  log: ReactNode | undefined
  watchlist: ReactNode
  book: ReactNode
  tape: ReactNode
}) {
  const layout = useFillViewport<HTMLDivElement>()
  const id = useId()
  const content: Record<Panel, ReactNode> = {
    Sweeps: log,
    Watchlist: watchlist,
    "Order book": book,
    Tape: tape,
  }
  const panels = PANELS.filter((panel) => content[panel] !== undefined)
  const [picked, pick] = useState<Panel>("Sweeps")
  const shown = panels.includes(picked) ? picked : panels[0]
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
        log === undefined
          ? "lg:grid-cols-[minmax(0,1fr)_400px]"
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
            onClick={() => pick(name)}
            className={cn(
              "flex-1 rounded-sm px-2 py-1",
              name === shown
                ? "bg-elevated text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {name}
          </button>
        ))}
      </div>
      {panel("Sweeps", "*:flex-1")}
      {/* Below `lg` its panels are the grid's own rows, under the tabs. */}
      <div className="min-w-0 max-lg:contents lg:flex lg:flex-col lg:gap-4">
        {panel("Watchlist")}
        {panel("Order book")}
        {panel("Tape")}
      </div>
    </div>
  )
}
