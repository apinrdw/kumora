import { IconChevronUp } from "@tabler/icons-react"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { cn } from "@workspace/ui/lib/utils"
import { Effect, Schema } from "effect"
import { useState } from "react"
import type { ComponentProps, ReactNode } from "react"

import { asOf, compactIdr, idr, shares } from "@/lib/format"
import { Delta } from "./delta"
import { KStateBody } from "./empty-state"
import type { KDataState } from "./empty-state"
import { KSkeleton } from "./skeleton"
import { KStatusPill } from "./status-pill"
import { Freshness } from "@/domain/freshness"
import { isActivationKey } from "./keyboard"
import { sortRows } from "./sort"
import type { KSort } from "./sort"
import { kFocus } from "./styles"
import type { Density } from "./ticker-row"
import { KTooltip } from "./tooltip"

/** Built-in cell formats. `ticker` shows `row.name` under the symbol when present. */
export type CellKind =
  | "pct"
  | "idr"
  | "compactIdr"
  | "shares"
  | "ticker"
  | "status"
  | "asOf"

export type KColumn<TRow extends object> = {
  key: Extract<keyof TRow, string>
  label: string
  /** Defaults to right for numeric kinds, left otherwise. */
  align?: "left" | "right" | "center"
  sortable?: boolean
  /** Methodology note, shown as the header tooltip. */
  description?: string
  cell?: CellKind | ((row: TRow) => ReactNode)
}

export type KDataTableProps<TRow extends object> = {
  columns: ReadonlyArray<KColumn<TRow>>
  rows: ReadonlyArray<TRow>
  getRowId: (row: TRow) => string
  /** Accessible name of the table. */
  label: string
  caption?: string
  density?: Density
  defaultSort?: KSort<TRow>
  /** Controlled sort. With `onSort` set the table does not reorder rows itself. */
  sort?: KSort<TRow>
  onSort?: (sort: KSort<TRow>) => void
  /** Keep the first (ticker) column visible on horizontal scroll. */
  stickyFirst?: boolean
  selectedId?: string
  onRowClick?: (row: TRow) => void
  /** Non-ready states replace the body. Ready with no rows shows `no-result`. */
  state?: KDataState
  className?: string
}

const NUMERIC_KINDS: ReadonlySet<CellKind> = new Set([
  "pct",
  "idr",
  "compactIdr",
  "shares",
  "asOf",
])

type Align = "left" | "right" | "center"

const alignOf = <TRow extends object>(c: KColumn<TRow>): Effect.Effect<Align> =>
  Effect.succeed(
    c.align ??
      (typeof c.cell === "string" && NUMERIC_KINDS.has(c.cell)
        ? "right"
        : "left")
  )

const ALIGN = {
  left: "text-left",
  right: "num text-right",
  center: "text-center",
} as const

const isFreshness = Schema.is(Freshness)

type KindRenderer = (
  v: NonNullable<unknown>,
  row: object
) => Effect.Effect<ReactNode>

const numberCell = (
  v: unknown,
  format: (n: number) => Effect.Effect<ReactNode>
): Effect.Effect<ReactNode> =>
  typeof v === "number" ? format(v) : Effect.succeed("—")

const signTone = (n: number) =>
  Effect.succeed(n > 0 ? "text-up" : n < 0 ? "text-down" : undefined)

function TickerCell({ symbol, row }: { symbol: string; row: object }) {
  return (
    <span className="num font-[650] text-foreground">
      {symbol}
      {"name" in row && typeof row.name === "string" && (
        <span className="text-secondary-text block font-sans text-[11px] leading-[14px] font-normal">
          {row.name}
        </span>
      )}
    </span>
  )
}

const KIND_RENDERERS: Record<CellKind, KindRenderer> = {
  pct: (v) => numberCell(v, (n) => Effect.succeed(<Delta value={n} />)),
  idr: (v) => numberCell(v, idr),
  compactIdr: (v) =>
    numberCell(v, (n) =>
      Effect.gen(function* () {
        const tone = yield* signTone(n)
        return <span className={tone}>{yield* compactIdr(n)}</span>
      })
    ),
  shares: (v) => numberCell(v, shares),
  ticker: (v, row) =>
    Effect.succeed(
      typeof v === "string" ? <TickerCell symbol={v} row={row} /> : "—"
    ),
  status: (v) =>
    Effect.succeed(isFreshness(v) ? <KStatusPill status={v} hideAsOf /> : "—"),
  asOf: (v) => (typeof v === "string" ? asOf(v) : Effect.succeed("—")),
}

const renderKind = (
  kind: CellKind,
  v: unknown,
  row: object
): Effect.Effect<ReactNode> =>
  v === null || v === undefined
    ? Effect.succeed("—")
    : KIND_RENDERERS[kind](v, row)

const plain = (v: unknown): Effect.Effect<ReactNode> =>
  Effect.succeed(typeof v === "string" || typeof v === "number" ? v : "—")

const renderCell = <TRow extends object>(
  c: KColumn<TRow>,
  row: TRow
): Effect.Effect<ReactNode> => {
  const { cell } = c
  if (typeof cell === "function") return Effect.sync(() => cell(row))
  if (cell) return renderKind(cell, row[c.key], row)
  return plain(row[c.key])
}

type SortDir = KSort<object>["dir"]

/** Direction of the active sort on this column, or undefined when it is not the sort key. */
const activeDir = <TRow extends object>(
  c: KColumn<TRow>,
  sort: KSort<TRow> | undefined
): Effect.Effect<SortDir | undefined> =>
  Effect.succeed(sort?.key === c.key ? sort.dir : undefined)

const ariaSortOf = (sortable: boolean | undefined, dir: SortDir | undefined) =>
  Effect.succeed(
    !sortable
      ? undefined
      : !dir
        ? ("none" as const)
        : dir === "asc"
          ? ("ascending" as const)
          : ("descending" as const)
  )

// A header cell's sort direction, alignment and aria-sort.
const headerOf = <TRow extends object>(
  c: KColumn<TRow>,
  sort: KSort<TRow> | undefined
) =>
  Effect.gen(function* () {
    const dir = yield* activeDir(c, sort)
    return {
      dir,
      align: yield* alignOf(c),
      ariaSort: yield* ariaSortOf(c.sortable, dir),
    }
  })

type StateBody = Exclude<KDataState, { status: "ready" }>

/** The state that replaces the body, or null when rows render. */
const bodyState = (
  state: KDataState,
  rowCount: number
): Effect.Effect<StateBody | null> =>
  Effect.succeed(
    state.status !== "ready"
      ? state
      : rowCount === 0
        ? { status: "empty", kind: "no-result" }
        : null
  )

/** Spreads every other button prop so it can serve as a tooltip trigger. */
function SortButton({
  label,
  align,
  dir,
  className,
  ...buttonProps
}: ComponentProps<"button"> & {
  label: string
  align: "left" | "right" | "center"
  dir: SortDir | undefined
}) {
  return (
    <button
      type="button"
      {...buttonProps}
      className={cn(
        "inline-flex items-center gap-1 rounded-xs hover:text-foreground",
        align === "right" && "flex-row-reverse",
        kFocus,
        className
      )}
    >
      {label}
      <IconChevronUp
        aria-hidden
        stroke={1.75}
        className={cn(
          "size-3 transition-transform",
          dir ? "text-primary" : "opacity-40",
          dir === "desc" && "rotate-180"
        )}
      />
    </button>
  )
}

function HeaderLabel<TRow extends object>({
  column: c,
  align,
  dir,
  onToggle,
}: {
  column: KColumn<TRow>
  align: "left" | "right" | "center"
  dir: SortDir | undefined
  onToggle: () => void
}) {
  if (!c.sortable && !c.description) return c.label
  const trigger = c.sortable ? (
    <SortButton label={c.label} align={align} dir={dir} onClick={onToggle} />
  ) : (
    <button type="button" className={cn("rounded-xs", kFocus)}>
      {c.label}
    </button>
  )
  if (!c.description) return trigger
  return (
    <KTooltip explain content={c.description}>
      {trigger}
    </KTooltip>
  )
}

function HeaderCell<TRow extends object>({
  column: c,
  sort,
  sticky,
  onToggle,
}: {
  column: KColumn<TRow>
  sort: KSort<TRow> | undefined
  sticky: boolean
  onToggle: () => void
}) {
  const { dir, align, ariaSort } = Effect.runSync(headerOf(c, sort))
  return (
    <TableHead
      scope="col"
      aria-sort={ariaSort}
      className={cn(
        "bg-surface h-9 border-b border-border px-3 text-xs font-[450] text-muted-foreground",
        dir && "text-foreground",
        ALIGN[align],
        "font-sans",
        sticky && "sticky left-0 z-[2]"
      )}
    >
      <HeaderLabel column={c} align={align} dir={dir} onToggle={onToggle} />
    </TableHead>
  )
}

function DataRow<TRow extends object>({
  row,
  columns,
  selected,
  rowHeight,
  stickyFirst,
  onRowClick,
}: {
  row: TRow
  columns: ReadonlyArray<KColumn<TRow>>
  selected: boolean
  rowHeight: string
  stickyFirst: boolean
  onRowClick?: (row: TRow) => void
}) {
  return (
    <TableRow
      aria-selected={selected || undefined}
      tabIndex={onRowClick ? 0 : undefined}
      onClick={onRowClick && (() => onRowClick(row))}
      onKeyDown={
        onRowClick &&
        ((e) => {
          if (!Effect.runSync(isActivationKey(e.key))) return
          e.preventDefault()
          onRowClick(row)
        })
      }
      className={cn(
        "group/row border-0 hover:bg-transparent",
        onRowClick &&
          cn("cursor-pointer", kFocus, "focus-visible:outline-offset-[-2px]")
      )}
    >
      {columns.map((c, ci) => (
        <TableCell
          key={c.key}
          className={cn(
            rowHeight,
            "bg-surface group-hover/row:bg-elevated group-aria-selected/row:bg-selected border-b border-border px-3 py-0 group-last/row:border-b-0",
            ALIGN[Effect.runSync(alignOf(c))],
            ci === 0 && stickyFirst && "sticky left-0 z-[1]"
          )}
        >
          {Effect.runSync(renderCell(c, row))}
        </TableCell>
      ))}
    </TableRow>
  )
}

type TableRowsProps<TRow extends object> = Pick<
  KDataTableProps<TRow>,
  "columns" | "getRowId" | "density" | "selectedId" | "onRowClick"
> & {
  rows: ReadonlyArray<TRow>
  state: KDataState
  stickyFirst: boolean
}

function TableRows<TRow extends object>({
  columns,
  rows,
  getRowId,
  density = "compact",
  selectedId,
  onRowClick,
  state,
  stickyFirst,
}: TableRowsProps<TRow>) {
  const body = Effect.runSync(bodyState(state, rows.length))
  if (body) {
    return (
      <TableRow className="border-0 hover:bg-transparent">
        <TableCell colSpan={columns.length} className="p-0 whitespace-normal">
          <KStateBody
            state={body}
            skeleton={<KSkeleton kind="table" className="p-3" />}
          />
        </TableCell>
      </TableRow>
    )
  }
  const rowHeight = density === "compact" ? "h-9" : "h-11 text-sm"
  return (
    <>
      {rows.map((row) => {
        const id = getRowId(row)
        return (
          <DataRow
            key={id}
            row={row}
            columns={columns}
            selected={selectedId === id}
            rowHeight={rowHeight}
            stickyFirst={stickyFirst}
            onRowClick={onRowClick}
          />
        )
      })}
    </>
  )
}

export function KDataTable<TRow extends object>({
  columns,
  rows,
  label,
  caption,
  defaultSort,
  sort: controlledSort,
  onSort,
  stickyFirst = false,
  state = { status: "ready" },
  className,
  ...rowProps
}: KDataTableProps<TRow>) {
  const [ownSort, setOwnSort] = useState(defaultSort)
  const sort = controlledSort ?? ownSort

  const sorted = sort && !onSort ? Effect.runSync(sortRows(rows, sort)) : rows

  function toggleSort(key: KSort<TRow>["key"]) {
    const next: KSort<TRow> = {
      key,
      dir: sort?.key === key && sort.dir === "desc" ? "asc" : "desc",
    }
    if (!controlledSort) setOwnSort(next)
    onSort?.(next)
  }

  return (
    <div
      className={cn(
        "bg-surface max-w-full overflow-hidden rounded-md border border-border",
        className
      )}
    >
      <Table
        aria-label={label}
        className="border-separate border-spacing-0 text-[13px] leading-[18px]"
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        <TableHeader>
          <TableRow className="border-0 hover:bg-transparent">
            {columns.map((c, ci) => (
              <HeaderCell
                key={c.key}
                column={c}
                sort={sort}
                sticky={ci === 0 && stickyFirst}
                onToggle={() => toggleSort(c.key)}
              />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRows
            {...rowProps}
            columns={columns}
            rows={sorted}
            state={state}
            stickyFirst={stickyFirst}
          />
        </TableBody>
      </Table>
    </div>
  )
}
