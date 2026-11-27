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
import type { HolderMapView } from "@/lib/holder-map"
import type { LegendEntry, LinkMove, Refocus } from "@/lib/holder-map-graph"

import {
  CUSTODIAN_COLOR,
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
  Effect.succeed(`${count} ${count === 1 ? one : many}`)

// What each focus's hops are: its first hop's, and the hop beyond's.
const HOPS: Record<
  Focus["kind"],
  readonly ["holder" | "stock", "holder" | "stock"]
> = {
  stock: ["holder", "stock"],
  holder: ["stock", "holder"],
  custodian: ["holder", "stock"],
}

// The chart's name: what it is of, its first hop's holdings, its Off list
// while shown, and the hop beyond: a custodian focus's holders, then the
// stocks it holds for them.
const mapLabel = Effect.fnUntraced(function* (
  focus: Focus,
  showOffList: boolean
) {
  const [near, far] = HOPS[focus.kind]
  const drawn = focus.graph.nodes.filter((node) => !node.focus && !node.offList)
  const first = drawn.filter(({ kind }) => kind === near).length
  const beyond = drawn.filter(({ kind }) => kind === far).length
  const offList = showOffList
    ? focus.graph.nodes.filter((node) => node.offList).length
    : 0
  return [
    `Holder map of ${focus.title}: `,
    yield* counted(first, near, `${near}s`),
    offList === 0 ? "" : ` and ${offList} Off list`,
    beyond === 0
      ? ""
      : focus.kind === "custodian"
        ? `, in ${yield* counted(beyond, "stock", "stocks")}`
        : `, ${yield* counted(beyond, `other ${far}`, `other ${far}s`)} a hop beyond`,
    ". The tables below list each.",
  ].join("")
})

export type HolderMapGraphProps = {
  focus: Focus
  // The page's Off list toggle, which hides the Off list holders' nodes.
  showOffList: boolean
  onRefocus: (refocus: Refocus) => void
  // The node a search highlighted: labelled, and named above the map.
  searched: string | undefined
  onClearSearched: () => void
}

export function HolderMapGraph({
  focus,
  showOffList,
  onRefocus,
  searched,
  onClearSearched,
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
          searched,
          showOffList,
          nodeOf,
        })
      ),
    [layout, view, size, graph, hovered, searched, showOffList, nodeOf]
  )
  const searchedNode =
    searched === undefined ? undefined : nodeById.get(searched)
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
      {searchedNode !== undefined && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground"
        >
          <span>
            <span className="font-medium text-foreground">
              {searchedNode.name}
            </span>{" "}
            is labelled on the map.
          </span>
          {searchedNode.refocus !== undefined && (
            <KButton
              variant="secondary"
              size="sm"
              onClick={() =>
                searchedNode.refocus && onRefocus(searchedNode.refocus)
              }
            >
              Focus it
            </KButton>
          )}
          <KButton variant="ghost" size="sm" onClick={onClearSearched}>
            Clear
          </KButton>
        </p>
      )}
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
  custodian: { background: CUSTODIAN_COLOR },
  "5%": { background: "var(--text-secondary)" },
  "1%": { border: "2px solid var(--text-secondary)" },
  local: { background: ORIGIN_COLOR.local },
  foreign: { background: ORIGIN_COLOR.foreign },
  mixed: { background: ORIGIN_COLOR.mixed },
  unknown: { background: ORIGIN_COLOR.unknown },
}

// A move's swatch is a short stroke, as its link is drawn: Off list's
// dashed.
const MOVE_SWATCH = Object.fromEntries(
  Object.entries(MOVE_COLOR).map(([move, color]) => [
    move,
    move === "off list"
      ? {
          height: 2,
          width: 12,
          background: `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 5px)`,
        }
      : { height: 3, width: 12, borderRadius: 2, background: color },
  ])
) as Record<LinkMove, CSSProperties>

const LEGEND_NOTE: Partial<Record<string, string>> = {
  stock: "code inside",
  holder: "KSEI type inside, size by stake",
  custodian: "broker code inside, links by shares held",
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
              style={MOVE_SWATCH[entry.key]}
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
