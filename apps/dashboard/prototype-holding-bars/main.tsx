// PROTOTYPE (wayfinder #382), throwaway: Holding composition with its Bars
// view swapped per `#variant-<key>`, and a floating switcher.
import "@/styles.css"
import "./proto.css"

import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"

import type { ChartView, OriginShown } from "@/lib/stock-search"

import { series } from "./fixture"
import { type BarsProps, HoldingComposition, TodayBars } from "./shell"
import { VariantA, VariantB, VariantC } from "./variants"

const VARIANTS: ReadonlyArray<{
  key: string
  name: string
  note: string
  bars: (props: BarsProps) => React.ReactNode
}> = [
  {
    key: "A",
    name: "Native chart",
    note: "One tab stop. Arrow keys / Home / End step months; hover shows the library tooltip with our sorted body. Screen readers hear the month through a live region.",
    bars: (props) => <VariantA {...props} />,
  },
  {
    key: "B",
    name: "Button overlay",
    note: "TanStack only paints. A transparent button per month sits over each column with today's KTooltip, so Tab visits every month and today's tests keep working.",
    bars: (props) => <VariantB {...props} />,
  },
  {
    key: "C",
    name: "Readout panel",
    note: "No floating tooltip. Hover, tap or arrow a month and the readout above fills; it opens on the newest month. Hiding a series animates.",
    bars: (props) => <VariantC {...props} />,
  },
  {
    key: "Today",
    name: "Today (hand-built)",
    note: "The current hand-built divs, for comparison.",
    bars: (props) => <TodayBars {...props} />,
  },
]

// The variant rides in `#variant-a` (an Artifact keeps only a plain hash).
const current = () =>
  VARIANTS.find(
    (each) =>
      `#variant-${each.key.toLowerCase()}` === location.hash.toLowerCase()
  )?.key ?? "A"

function App() {
  const [variant, setVariant] = useState(current)
  const [origin, setOrigin] = useState<OriginShown>("local")
  const [view, setView] = useState<ChartView>("bars")
  const index = Math.max(
    0,
    VARIANTS.findIndex((each) => each.key === variant)
  )
  const active = VARIANTS[index]!
  const go = (step: number) => {
    const next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length]!
    location.hash = `variant-${next.key.toLowerCase()}`
    setVariant(next.key)
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (
        target.closest(
          "input, textarea, [contenteditable], svg, .ts-chart-host"
        )
      )
        return
      if (event.key === "[") go(-1)
      if (event.key === "]") go(1)
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  })
  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-[1100px] flex-col gap-4 p-4 pb-32">
        <header className="flex flex-col gap-1">
          <h1 className="text-[18px] font-semibold">
            PROTOTYPE · Holding composition on TanStack Charts 1.5.0
          </h1>
          <p className="text-[13px] text-muted-foreground">
            Made-up stock, Nov 2018 – Oct 2026, with no KSEI data for Apr 2020
            and Sep 2023. Only the Bars view changes between variants.
          </p>
        </header>
        <div className="rounded-sm border border-dashed border-border px-3 py-2 text-[13px]">
          <b>
            {active.key} · {active.name}
          </b>
          <span className="text-muted-foreground"> — {active.note}</span>
        </div>
        <HoldingComposition
          key={active.key}
          bars={active.bars}
          series={series}
          origin={origin}
          view={view}
          onOrigin={setOrigin}
          onView={setView}
        />
      </main>
      <nav className="proto-switcher" aria-label="Prototype variants">
        <button
          type="button"
          onClick={() => go(-1)}
          aria-label="Previous variant"
        >
          ←
        </button>
        <span>
          {active.key} · {active.name}
        </span>
        <button type="button" onClick={() => go(1)} aria-label="Next variant">
          →
        </button>
      </nav>
    </TooltipProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
