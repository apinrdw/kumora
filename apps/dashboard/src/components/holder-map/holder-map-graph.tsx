// The Holder map's graph (spec apinrdw/kumora#733, "Rendering";
// apinrdw/kumora#735): the view model's nodes and links, laid out in a web
// worker, drawn with TanStack Charts, links and dots on Canvas and labels
// in SVG. The page pans and zooms both axes itself, since the library zooms
// x only, and a click on a node refocuses the map on it.
import type { ChartPoint } from "@tanstack/charts"
import { Chart } from "@tanstack/charts/react"
import { IconFocusCentered, IconMinus, IconPlus } from "@tabler/icons-react"
import { Effect } from "effect"
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { KButton } from "@/components/k/button"
import type {
  HolderMapView,
  LegendEntry,
  LinkMove,
  Refocus,
} from "@/lib/holder-map"

import {
  mapDefinition,
  MOVE_COLOR,
  ORIGIN_COLOR,
  STOCK_COLOR,
} from "./map-definition"
import { useHolderMapLayout } from "./use-holder-map-layout"
import { useMapViewport } from "./use-map-viewport"

type Focus = NonNullable<HolderMapView["focus"]>

// The map's height in px, and a zoom button's step.
const HEIGHT = 480
const BUTTON_ZOOM = 1.5

// The map's width in px, as laid out.
function useWidth(element: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState<number>()
  useEffect(() => {
    const current = element.current
    if (current === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(current)
    return () => observer.disconnect()
  }, [element])
  return width
}

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`

// The chart's name: what it is of, its first hop's holdings, its Off list
// while shown, and the hop beyond.
const mapLabel = (focus: Focus, showOffList: boolean) =>
  Effect.sync(() => {
    const [near, far] =
      focus.kind === "stock"
        ? (["holder", "stock"] as const)
        : (["stock", "holder"] as const)
    const drawn = focus.graph.nodes.filter(
      (node) => !node.focus && !node.offList
    )
    const first = drawn.filter(({ kind }) => kind === near).length
    const beyond = drawn.filter(({ kind }) => kind === far).length
    const offList = showOffList
      ? focus.graph.nodes.filter((node) => node.offList).length
      : 0
    return [
      `Holder map of ${focus.title}: `,
      near === "holder"
        ? counted(first, "holder", "holders")
        : counted(first, "stock", "stocks"),
      offList === 0 ? "" : ` and ${offList} Off list`,
      beyond === 0
        ? ""
        : `, ${far === "stock" ? counted(beyond, "other stock", "other stocks") : counted(beyond, "other holder", "other holders")} a hop beyond`,
      ". The tables below list each.",
    ].join("")
  })

export type HolderMapGraphProps = {
  focus: Focus
  // The page's Off list toggle, which hides the Off list holders' nodes.
  showOffList: boolean
  onRefocus: (refocus: Refocus) => void
}

export function HolderMapGraph({
  focus,
  showOffList,
  onRefocus,
}: HolderMapGraphProps) {
  const { graph, legend } = focus
  const frame = useRef<HTMLDivElement>(null)
  const width = useWidth(frame)
  const size = useMemo(
    () => (width === undefined ? undefined : { width, height: HEIGHT }),
    [width]
  )
  const layout = useHolderMapLayout(graph)
  const viewport = useMapViewport(frame, layout, size)
  const { view } = viewport
  const [hovered, setHovered] = useState<string>()
  const nodeById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph]
  )
  // The node a chart point draws.
  const nodeOf = useCallback(
    (datum: unknown) =>
      typeof datum === "object" && datum !== null && "id" in datum
        ? nodeById.get(String(datum.id))
        : undefined,
    [nodeById]
  )
  const definition = useMemo(
    () =>
      layout &&
      view &&
      size &&
      Effect.runSync(
        mapDefinition({
          graph,
          layout,
          view,
          size,
          hovered,
          showOffList,
          nodeOf,
        })
      ),
    [layout, view, size, graph, hovered, showOffList, nodeOf]
  )
  const ariaLabel = useMemo(
    () => Effect.runSync(mapLabel(focus, showOffList)),
    [focus, showOffList]
  )
  return (
    <section aria-labelledby="holder-map-graph" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="holder-map-graph" className="text-[15px] font-semibold">
          Map
        </h3>
        <div className="flex gap-1">
          <ZoomButton
            label="Zoom in"
            icon={IconPlus}
            disabled={!definition}
            onClick={() => viewport.zoom(BUTTON_ZOOM)}
          />
          <ZoomButton
            label="Zoom out"
            icon={IconMinus}
            disabled={!definition}
            onClick={() => viewport.zoom(1 / BUTTON_ZOOM)}
          />
          <KButton
            variant="secondary"
            size="sm"
            icon={IconFocusCentered}
            disabled={!definition}
            onClick={viewport.fit}
          >
            Fit to view
          </KButton>
        </div>
      </div>
      <div
        ref={frame}
        className="relative cursor-grab touch-none overflow-hidden rounded-md border border-border select-none active:cursor-grabbing"
        style={{ height: HEIGHT }}
        {...viewport.frameHandlers}
      >
        {definition ? (
          <Chart
            definition={definition}
            ariaLabel={ariaLabel}
            height={HEIGHT}
            onFocusChange={(point: ChartPoint | null) =>
              setHovered(nodeOf(point?.datum)?.id)
            }
            onSelect={(point) => {
              const node = nodeOf(point?.datum)
              if (viewport.endedDrag() || node?.refocus === undefined) return
              if (!node.focus) onRefocus(node.refocus)
            }}
          />
        ) : (
          <p className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
            Laying out the map…
          </p>
        )}
      </div>
      <Legend entries={legend} />
    </section>
  )
}

function ZoomButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string
  icon: typeof IconPlus
  disabled: boolean
  onClick: () => void
}) {
  return (
    <KButton
      variant="secondary"
      size="sm"
      icon={icon}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    />
  )
}

const SWATCH: Record<string, CSSProperties> = {
  stock: { background: STOCK_COLOR },
  holder: { background: "var(--text-secondary)" },
  "5%": { background: "var(--text-secondary)" },
  "1%": { border: "2px solid var(--text-secondary)" },
  local: { background: ORIGIN_COLOR.local },
  foreign: { background: ORIGIN_COLOR.foreign },
  mixed: { background: ORIGIN_COLOR.mixed },
  unknown: { background: ORIGIN_COLOR.unknown },
}

// A move's swatch is a short stroke, as its link is drawn: Off list's
// dashed.
const moveSwatch = (move: LinkMove): CSSProperties =>
  move === "off list"
    ? {
        height: 2,
        width: 12,
        background: `repeating-linear-gradient(90deg, ${MOVE_COLOR[move]} 0 3px, transparent 3px 5px)`,
      }
    : { height: 3, width: 12, borderRadius: 2, background: MOVE_COLOR[move] }

const LEGEND_NOTE: Partial<Record<string, string>> = {
  stock: "code inside",
  holder: "KSEI type inside, size by stake",
  "5%": "filled",
  "1%": "outlined",
}

function Legend({ entries }: { entries: ReadonlyArray<LegendEntry> }) {
  return (
    <ul
      aria-label="Legend"
      className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground"
    >
      {entries.map((entry) => (
        <li
          key={`${entry.kind} ${entry.key}`}
          className="flex items-center gap-1.5"
        >
          {entry.kind === "move" ? (
            <span
              aria-hidden
              className="inline-block shrink-0"
              style={moveSwatch(entry.key)}
            />
          ) : (
            <span
              aria-hidden
              className="inline-block size-2.5 shrink-0 rounded-full"
              style={SWATCH[entry.key]}
            />
          )}
          {entry.label}
          {LEGEND_NOTE[entry.key] && (
            <span className="text-[11px]">({LEGEND_NOTE[entry.key]})</span>
          )}
        </li>
      ))}
    </ul>
  )
}
