import { createFileRoute, useRouter } from "@tanstack/react-router"
import {
  IDX_SECTORS,
  UNCLASSIFIED,
  type SectorName,
  type StockCode,
} from "@workspace/relay"
import { clientRuntime } from "@workspace/client"
import { loadServerFn, runLoader } from "@workspace/server/loader"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import {
  IconAdjustmentsHorizontal,
  IconCamera,
  IconSearch,
} from "@tabler/icons-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { KButton } from "@/components/k/button"
import { KEmptyState } from "@/components/k/empty-state"
import { KInput } from "@/components/k/input"
import { KSelect } from "@/components/k/select"
import { BubbleCanvas } from "@/components/market-bubbles/bubble-canvas"
import { MarketStripBar } from "@/components/market-bubbles/market-strip-bar"
import { Pressed } from "@/components/market-bubbles/pressed"
import { snapshotMap } from "@/components/market-bubbles/snapshot"
import {
  useBubbleFrame,
  useCodeNames,
  type BubbleFrame,
} from "@/components/market-bubbles/use-bubble-frame"
import { useMarketFlow } from "@/components/market-bubbles/use-market-flow"
import { usePhone } from "@/components/market-bubbles/use-phone"
import { useSectors } from "@/components/market-bubbles/use-sectors"
import { useMarketPhase } from "@/components/market-live/market-conditions"
import { useStockCodeList } from "@/components/market-live/use-stock-code-list"
import { inSector } from "@/lib/bubble-sectors"
import {
  BUBBLE_WINDOWS,
  type BubbleFigures,
  type BubbleView,
  type ColourMetric,
  type MarketFlow,
  type SizeMetric,
  type TopN,
} from "@/lib/bubbles"
import { tapeTime } from "@/lib/format"
import {
  DEFAULT_VIEW,
  parseMarketBubblesSearch,
  PHONE_VIEW,
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

// "All sectors" is no sector in the URL.
const ALL_SECTORS = "all"
const SECTOR_OPTIONS: ReadonlyArray<{
  value: SectorName | typeof ALL_SECTORS
  label: string
}> = [
  { value: ALL_SECTORS, label: "All sectors" },
  ...[...IDX_SECTORS, UNCLASSIFIED].map((sector: SectorName) => ({
    value: sector,
    label: sector,
  })),
]

// The map's bubbles each second, the view's sector cut from the ranked ones.
function useSectorFrame(
  flow: MarketFlow,
  view: BubbleView,
  clockOffset: number
) {
  const sectors = useSectors()
  const { sector } = view
  const cut = useCallback(
    (ranked: ReadonlyArray<BubbleFigures>) => inSector(ranked, sectors, sector),
    [sectors, sector]
  )
  const phase = useMarketPhase()
  const frame = useBubbleFrame(flow, view, cut, phase, clockOffset)
  return { frame, sectors, phase }
}

// The snapshot button's handler, and the ref of the box that holds the
// map's canvas. The caption's time is Market Live's clock, `clockOffset` ms
// ahead of the browser's.
function useSnapshot(view: BubbleView, clockOffset: number) {
  const map = useRef<HTMLDivElement>(null)
  const snapshot = useCallback(() => {
    const canvas = map.current?.querySelector("canvas")
    if (canvas === null || canvas === undefined) return
    clientRuntime.runFork(
      snapshotMap(canvas, view, Date.now() + clockOffset).pipe(
        Effect.catchTag("SnapshotFailed", (error) =>
          Effect.logWarning("Snapshot not saved", error)
        )
      )
    )
  }, [view, clockOffset])
  return { map, snapshot }
}

// The view the URL names, over the device's defaults (Top 50 on a phone),
// and its change, which keeps those defaults out of the URL.
function useBubbleView() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const phone = usePhone()
  const defaults = phone ? PHONE_VIEW : DEFAULT_VIEW
  const view = useMemo(
    () => Effect.runSync(viewOfSearch(search, defaults)),
    [search, defaults]
  )
  const change = useCallback(
    (patch: MarketBubblesSearch) => {
      const next = Effect.runSync(searchOfView(patch, defaults))
      void navigate({
        search: (previous: MarketBubblesSearch) => ({ ...previous, ...next }),
        replace: true,
        resetScroll: false,
      })
    },
    [navigate, defaults]
  )
  // A `top` the URL names that is this device's default leaves the URL, once
  // the device is known (parseMarketBubblesSearch's Decision).
  const { top } = search
  useEffect(() => {
    if (phone !== undefined && top === defaults.top) change({ top })
  }, [phone, top, defaults, change])
  return { view, change, navigate }
}

// The loader's live day, asked again once its date turns, as Market Live's
// is, so the flow, its backfill and the code list move to the new day
// together.
function useLiveDay() {
  const day = Route.useLoaderData()
  const router = useRouter()
  const { dayEndsIn } = day
  useEffect(() => {
    const timer = setTimeout(() => void router.invalidate(), dayEndsIn + 1000)
    return () => clearTimeout(timer)
  }, [router, dayEndsIn])
  return day
}

function MarketBubblesPage() {
  const { today, clockOffset } = useLiveDay()
  const { view, change, navigate } = useBubbleView()
  const openLive = useCallback(
    (code: StockCode) =>
      void navigate({ to: "/market-live", search: { code } }),
    [navigate]
  )
  const { flow, status, ihsg } = useMarketFlow(today, clockOffset)
  const { frame, sectors, phase } = useSectorFrame(flow, view, clockOffset)
  const showSector = useCallback(
    (sector: SectorName) => change({ sector }),
    [change]
  )
  const [find, setFind] = useState("")
  const { map, snapshot } = useSnapshot(view, clockOffset)
  const names = useCodeNames(useStockCodeList(undefined, today))
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
      <MarketStripBar
        flow={flow}
        ihsg={ihsg}
        today={today}
        phase={phase}
        clockOffset={clockOffset}
      />
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
      <Filters
        view={view}
        onChange={change}
        frame={frame}
        find={find}
        onFind={setFind}
        onSnapshot={snapshot}
      />
      {frame._tag === "Empty" ? (
        <KEmptyState
          kind="no-data"
          title="Bubbles start with the first trade at 09:00"
          description="Each stock code joins the map with its first regular-board trade of the day."
          className="mx-auto"
        />
      ) : (
        // The snapshot reads the map's canvas from here.
        <div ref={map}>
          <BubbleCanvas
            bubbles={frame._tag === "Shown" ? frame.bubbles : []}
            view={view}
            names={names}
            sectors={sectors}
            search={find}
            onPick={openLive}
            onPickSector={showSector}
            className="h-[calc(100dvh-15rem)] min-h-[420px] border-t border-border"
          />
        </div>
      )}
    </div>
  )
}

// "Session closed, showing up to 15:49:58" while no session runs.
function SessionLabel({ frame }: { frame: BubbleFrame }) {
  if (frame._tag !== "Shown" || !frame.closed) return null
  return (
    <p role="status" className="text-warning text-xs">
      Session closed, showing up to {Effect.runSync(tapeTime(frame.end))}
    </p>
  )
}

interface ControlsProps {
  view: BubbleView
  onChange: (patch: MarketBubblesSearch) => void
  frame: BubbleFrame
  find: string
  onFind: (find: string) => void
  onSnapshot: () => void
}

// The controls in a row, or below `lg` one Filters row that opens them in a
// sheet, so the map keeps the phone's screen.
function Filters(props: ControlsProps) {
  const [open, setOpen] = useState(false)
  const { view, frame } = props
  return (
    <>
      <Controls {...props} className="max-lg:hidden" />
      <div className="flex items-center gap-3 text-xs lg:hidden">
        <KButton
          variant="secondary"
          size="sm"
          icon={IconAdjustmentsHorizontal}
          onClick={() => setOpen(true)}
        >
          Filters
        </KButton>
        <span className="truncate text-muted-foreground">
          {[
            SIZE_OPTIONS.find((option) => option.value === view.size)?.label,
            view.window,
            TOP_OPTIONS.find((option) => option.value === view.top)?.label,
            view.sector,
            frame._tag === "Shown" && `${frame.bubbles.length} codes`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="lg:hidden">
          <SheetHeader className="pb-0">
            <SheetTitle>Filters</SheetTitle>
          </SheetHeader>
          <Controls
            {...props}
            className="px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
          />
        </SheetContent>
      </Sheet>
    </>
  )
}

function Controls({
  view,
  onChange,
  frame,
  find,
  onFind,
  onSnapshot,
  className,
}: ControlsProps & { className: string }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-end gap-x-3 gap-y-2 text-xs",
        className
      )}
    >
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
      <KSelect
        label="Sector"
        size="xs"
        options={SECTOR_OPTIONS}
        value={view.sector ?? ALL_SECTORS}
        onValueChange={(sector) =>
          onChange({ sector: sector === ALL_SECTORS ? undefined : sector })
        }
        className="w-52"
      />
      <KInput
        type="search"
        label="Find a stock code"
        hideLabel
        icon={IconSearch}
        placeholder="Find a code"
        value={find}
        onChange={(event) => onFind(event.target.value)}
        className="w-36"
      />
      {frame._tag === "Shown" && (
        <span className="pb-2 text-muted-foreground">
          {frame.bubbles.length} codes
        </span>
      )}
      <KButton
        variant="secondary"
        size="sm"
        icon={IconCamera}
        onClick={onSnapshot}
        disabled={frame._tag !== "Shown"}
        className="ml-auto"
      >
        Snapshot
      </KButton>
    </div>
  )
}
