import type { StockCode } from "@workspace/client"
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
  all: "All codes",
  tape: "Tape",
  watchlist: "Watchlist",
  book: "Order book",
}

// The panels the middle column holds from `lg`, as its tabs. The others
// stack in the right column.
const MIDDLE: ReadonlyArray<Panel> = ["sweeps", "all", "tape"]

// A bar of tabs, one per panel in `panels`, `shown` selected. Each tab
// controls its panel's element, `${id}-${name}`.
function PanelTabs({
  label,
  panels,
  shown,
  names,
  id,
  onPanel,
  className,
}: {
  label: string
  panels: ReadonlyArray<Panel>
  shown: Panel | undefined
  names: Record<Panel, string>
  id: string
  onPanel: (panel: Panel) => void
  className: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "flex gap-0.5 rounded-md border border-border bg-sidebar p-0.5 text-[13px]",
        className
      )}
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
            "min-w-0 flex-1 truncate rounded-sm px-2 py-1",
            name === shown
              ? "bg-elevated text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {names[name]}
        </button>
      ))}
    </div>
  )
}

/**
 * Layout B (spec apinrdw/kumora#263, "Layout, settings, indices and
 * phone"). From `lg`: the chart column; the middle column, whose tabs show
 * the sweep log, All codes or the tape (apinrdw/kumora#702,
 * apinrdw/kumora#705); and the 400 px right
 * column of `watchlist` and `book`; at least as tall as the window below
 * them. The tape scrolls sideways in its column (tape-list.tsx). Below `lg`:
 * the charts stacked full width, then tabs showing one panel at a time. A
 * bar shows `panel`, kept by the page in its URL, when it has that tab, else
 * its first. No `log` (an index): no sweep log or tab for it; no
 * `allCodes` (a recorded day or an index): no All codes tab.
 */
export function LayoutB({
  code,
  charts,
  log,
  allCodes,
  withBrokers,
  watchlist,
  book,
  tape,
  panel: picked,
  onPanel,
}: {
  // The selected code, which the sweep log's tab names.
  code: StockCode
  charts: ReactNode
  log: ReactNode | undefined
  allCodes: ReactNode | undefined
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
    all: allCodes,
    tape,
    watchlist,
    book,
  }
  const panels = PANELS.filter((name) => content[name] !== undefined)
  const middle = panels.filter((name) => MIDDLE.includes(name))
  const pick = (among: ReadonlyArray<Panel>) =>
    picked !== undefined && among.includes(picked) ? picked : among[0]
  const shown = pick(panels)
  const middleShown = pick(middle)
  const middleNames: Record<Panel, string> = {
    ...TAB_NAMES,
    sweeps: `Buy/Sell sweeps · ${code}`,
    tape: "Running trades",
  }
  // A hidden tab's panel stays mounted (hidden by CSS), so the
  // tape keeps its socket and every panel its state across tab switches.
  const panel = (name: Panel, className?: string) =>
    content[name] !== undefined && (
      <div
        id={`${id}-${name}`}
        className={cn("flex min-w-0 flex-col", className, {
          "max-lg:hidden": name !== shown,
          "lg:hidden": MIDDLE.includes(name) && name !== middleShown,
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
        // The middle column is 340 px live. On a recorded day it flexes from
        // 340 to 530 px and gives way first: the charts keep 480 px, or what
        // a 340 px log, the 400 px column and two 16 px gaps (772 px) leave.
        // A narrower log scrolls its broker columns. See spec
        // apinrdw/kumora#343, "Log layout A", and PR apinrdw/kumora#349.
        withBrokers && log !== undefined
          ? "lg:grid-cols-[minmax(min(480px,calc(100%-772px)),1fr)_minmax(340px,530px)_400px]"
          : "lg:grid-cols-[minmax(0,1fr)_340px_400px]"
      )}
    >
      <div className="flex min-w-0 flex-col gap-4">{charts}</div>
      <PanelTabs
        label="Panels"
        panels={panels}
        shown={shown}
        names={TAB_NAMES}
        id={id}
        onPanel={onPanel}
        className="lg:hidden"
      />
      {/* Below `lg` the columns' panels are the grid's own rows, under the
          phone's tabs. */}
      <div className="min-w-0 max-lg:contents lg:flex lg:flex-col lg:gap-2">
        <PanelTabs
          label="Trades"
          panels={middle}
          shown={middleShown}
          names={middleNames}
          id={id}
          onPanel={onPanel}
          className="max-lg:hidden"
        />
        {panel("sweeps", "lg:flex-1 *:flex-1")}
        {panel("all", "lg:flex-1 *:flex-1")}
        {panel("tape")}
      </div>
      <div className="min-w-0 max-lg:contents lg:flex lg:flex-col lg:gap-4">
        {panel("watchlist")}
        {panel("book")}
      </div>
    </div>
  )
}
