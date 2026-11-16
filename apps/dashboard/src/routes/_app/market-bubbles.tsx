import { createFileRoute } from "@tanstack/react-router"
import type { MarketPhase, StockCode } from "@workspace/relay"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useCallback, useEffect, useMemo, useState } from "react"

import { KButton } from "@/components/k/button"
import { KEmptyState } from "@/components/k/empty-state"
import { KSelect } from "@/components/k/select"
import { BubbleCanvas } from "@/components/market-bubbles/bubble-canvas"
import { useMarketFlow } from "@/components/market-bubbles/use-market-flow"
import { useMarketPhase } from "@/components/market-live/market-conditions"
import { useStockCodeList } from "@/components/market-live/use-stock-code-list"
import {
  BUBBLE_WINDOWS,
  bubblesOf,
  windowEnd,
  type BubbleFigures,
  type BubbleView,
  type ColourMetric,
  type MarketFlow,
  type SizeMetric,
  type TopN,
} from "@/lib/bubbles"
import { tapeTime } from "@/lib/format"
import {
  parseMarketBubblesSearch,
  searchOfView,
  viewOfSearch,
  type MarketBubblesSearch,
} from "@/lib/market-bubbles-search"
import { marketBubblesFn } from "@/server/market-live/market-bubbles.functions"

export const Route = createFileRoute("/_app/market-bubbles")({
  staticData: {
    feature: "market-live",
    crumbs: () => Effect.succeed([{ label: "Market Bubbles" }]),
  },
  validateSearch: (raw: Record<string, unknown>) =>
    Effect.runSync(parseMarketBubblesSearch(raw)),
  loader: () => runLoader(loadServerFn(() => marketBubblesFn())),
  head: () => ({ meta: [{ title: "Market Bubbles · KUMORA Terminal" }] }),
  component: MarketBubblesPage,
})

// Figures recompute and bubbles re-target this often (spec
// apinrdw/kumora#427, "Cadence").
const RECOMPUTE_MS = 1000

const SIZE_OPTIONS: ReadonlyArray<{ value: SizeMetric; label: string }> = [
  { value: "value", label: "Value" },
  { value: "volume", label: "Volume" },
  { value: "freq", label: "Frequency" },
]
const COLOUR_OPTIONS: ReadonlyArray<{ value: ColourMetric; label: string }> = [
  { value: "delta", label: "Buy/Sell delta %" },
  { value: "change", label: "Price change %" },
]
const TOP_OPTIONS: ReadonlyArray<{ value: TopN; label: string }> = [
  { value: 100, label: "Top 100" },
  { value: 50, label: "Top 50" },
  { value: "all", label: "All" },
]

// What the map shows each second: the bubbles and where the windows end, or
// none before the day's first trade.
type Frame =
  | { readonly _tag: "Waiting" }
  | {
      readonly _tag: "Shown"
      readonly bubbles: ReadonlyArray<BubbleFigures>
      readonly end: number
      readonly closed: boolean
    }
  | { readonly _tag: "Empty" }

const WAITING: Frame = { _tag: "Waiting" }

// The bubbles of `view` each RECOMPUTE_MS, and at once when the view changes.
// The windows end at now on Market Live's clock, `clockOffset` ms ahead of
// the browser's, or at the day's last trade out of session.
function useBubbleFrame(
  flow: MarketFlow,
  view: BubbleView,
  phase: MarketPhase | undefined,
  clockOffset: number
): Frame {
  const [frame, setFrame] = useState<Frame>(WAITING)
  useEffect(() => {
    if (phase === undefined) return
    const recompute = () => {
      const ends = Effect.runSync(
        windowEnd(flow, phase, Date.now() + clockOffset)
      )
      if (ends === undefined) return setFrame({ _tag: "Empty" })
      const bubbles = Effect.runSync(bubblesOf(flow, view, ends.end))
      setFrame({ _tag: "Shown", bubbles, ...ends })
    }
    recompute()
    const timer = setInterval(recompute, RECOMPUTE_MS)
    return () => clearInterval(timer)
  }, [flow, view, phase, clockOffset])
  return frame
}

function MarketBubblesPage() {
  const search = Route.useSearch()
  const { today, clockOffset } = Route.useLoaderData()
  const navigate = Route.useNavigate()
  const view = useMemo(() => Effect.runSync(viewOfSearch(search)), [search])
  const change = useCallback(
    (patch: MarketBubblesSearch) => {
      const next = Effect.runSync(searchOfView(patch))
      void navigate({
        search: (previous: MarketBubblesSearch) => ({ ...previous, ...next }),
        replace: true,
        resetScroll: false,
      })
    },
    [navigate]
  )
  const openLive = useCallback(
    (code: StockCode) =>
      void navigate({ to: "/market-live", search: { code } }),
    [navigate]
  )
  const { flow, status } = useMarketFlow(today)
  const phase = useMarketPhase()
  const frame = useBubbleFrame(flow, view, phase, clockOffset)
  const list = useStockCodeList(undefined, today)
  const names = useMemo(
    () =>
      new Map(
        list._tag === "Ready"
          ? list.codes.map(({ code, name }) => [code, name] as const)
          : []
      ),
    [list]
  )
  return (
    <div data-flow={status} className="flex flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Market Bubbles</h1>
          <p className="text-xs text-muted-foreground">
            Every stock code as a bubble: size and colour from the metrics you
            pick, over the window you pick.
          </p>
        </div>
        <SessionLabel frame={frame} />
      </header>
      {status === "new-version" && (
        <div role="alert" className="flex items-center gap-3 text-[13px]">
          <span>
            A new version of Market Bubbles is out. Reload to continue.
          </span>
          <KButton size="sm" onClick={() => window.location.reload()}>
            Reload
          </KButton>
        </div>
      )}
      <Controls view={view} onChange={change} frame={frame} />
      {frame._tag === "Empty" ? (
        <KEmptyState
          kind="no-data"
          title="Bubbles start with the first trade at 09:00"
          description="Each stock code joins the map with its first regular-board trade of the day."
          className="mx-auto"
        />
      ) : (
        <BubbleCanvas
          bubbles={frame._tag === "Shown" ? frame.bubbles : []}
          view={view}
          names={names}
          onPick={openLive}
          className="h-[calc(100dvh-15rem)] min-h-[420px] border-t border-border"
        />
      )}
    </div>
  )
}

// "Session closed, showing up to 15:49:58" while no session runs.
function SessionLabel({ frame }: { frame: Frame }) {
  if (frame._tag !== "Shown" || !frame.closed) return null
  return (
    <p role="status" className="text-warning text-xs">
      Session closed, showing up to {Effect.runSync(tapeTime(frame.end))}
    </p>
  )
}

function Controls({
  view,
  onChange,
  frame,
}: {
  view: BubbleView
  onChange: (patch: MarketBubblesSearch) => void
  frame: Frame
}) {
  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 text-xs">
      <KSelect
        label="Size"
        size="xs"
        options={SIZE_OPTIONS}
        value={view.size}
        onValueChange={(size) => onChange({ size })}
        className="w-36"
      />
      <KSelect
        label="Colour"
        size="xs"
        options={COLOUR_OPTIONS}
        value={view.colour}
        onValueChange={(colour) => onChange({ colour })}
        className="w-44"
      />
      <Pressed
        label="Window"
        options={BUBBLE_WINDOWS.map((window) => ({
          value: window,
          label: window,
        }))}
        value={view.window}
        onPick={(window) => onChange({ window })}
      />
      <Pressed
        label="Codes shown"
        options={TOP_OPTIONS}
        value={view.top}
        onPick={(top) => onChange({ top })}
      />
      {frame._tag === "Shown" && (
        <span className="pb-2 text-muted-foreground">
          {frame.bubbles.length} codes
        </span>
      )}
    </div>
  )
}

// A row of buttons, one of them pressed.
function Pressed<T extends string | number>({
  label,
  options,
  value,
  onPick,
}: {
  label: string
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onPick: (value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex overflow-hidden rounded-md border border-border"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onPick(option.value)}
          className={cn(
            "border-border px-2.5 py-1.5 font-semibold not-first:border-l",
            option.value === value
              ? "bg-primary text-primary-foreground"
              : "bg-surface text-secondary-text hover:bg-elevated"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
