// The Major holders panel's holders of one above-1% report month (spec
// apinrdw/kumora#479, "Major holders panel"): the stock's ≥1% holders by %,
// each against the report month before, and those off the list since.
import { Effect } from "effect"

import { CLASSIFICATIONS, KSEI_TYPE_LABELS } from "@/domain/holdings"
import type {
  MajorHolder,
  MajorHoldersMonth,
} from "@/server/holdings/stock-page"

type Row = MajorHolder["rows"][number]

// Against the report month before: decided by the change in summed
// percentage, or absent from it (new) or from this month (off list).
export type Change = "new" | "up" | "down" | "unchanged" | "off list"

export interface HolderLine {
  readonly key: string
  // Its largest row's, by total shares.
  readonly name: string
  // Controller when any row is, else affiliate when any row is.
  readonly controller: Row["controller"]
  // Its largest row's classification label, or its KSEI type's in Feb–Mar
  // 2026; undefined when blank.
  readonly label: string | undefined
  readonly origin: Row["origin"]
  readonly domicile: string | undefined
  readonly rows: ReadonlyArray<Row>
  // An off-list holder's are the month before's.
  readonly percentageHundredths: number
  readonly total: number
  // Scrip ÷ total, 0 to 1; undefined of no shares.
  readonly inScrip: number | undefined
  // Undefined without a comparable month before.
  readonly change: Change | undefined
  // Up, down or unchanged only.
  readonly ppChange: number | undefined
  readonly shareChange: number | undefined
}

// What the month's changes are against: the report month before, or why
// there are none (the stock's first month, or the month before has no row
// for it).
export type Comparison =
  | { readonly kind: "compared" | "gap"; readonly dataDate: string }
  | { readonly kind: "first" }

export interface MonthHolders {
  readonly dataDate: string
  readonly comparison: Comparison
  // Listed this month, most % first.
  readonly listed: ReadonlyArray<HolderLine>
  // Listed the month before and not now, most % first.
  readonly offList: ReadonlyArray<HolderLine>
  // The listed holders' summed % × 100.
  readonly totalHundredths: number
  // Undefined without a comparable month before.
  readonly counts:
    | {
        readonly new: number
        readonly up: number
        readonly down: number
        readonly offList: number
      }
    | undefined
}

// A holder's largest row, by total shares: the one whose name it shows.
export const largestRow = (holder: MajorHolder) =>
  Effect.sync(() =>
    holder.rows.reduce((largest, row) =>
      row.total > largest.total ? row : largest
    )
  )

const controllerOf = (rows: ReadonlyArray<Row>) =>
  Effect.sync((): Row["controller"] => {
    const flags = new Set(rows.map(({ controller }) => controller))
    if (flags.has("controller")) return "controller"
    return flags.has("affiliate") ? "affiliate" : undefined
  })

const labelOf = ({ classification, type }: Row) =>
  Effect.succeed(
    classification === undefined
      ? type && KSEI_TYPE_LABELS[type]
      : CLASSIFICATIONS[classification].label
  )

// The month before's holders by key, when it is comparable.
type Before = ReadonlyMap<string, MajorHolder> | undefined

// The one movement rule, which the table's chips and the Every month grid's
// marks both follow: a holder's change against the month before's holders,
// by the change in summed hundredths, or new when absent from them;
// undefined without a comparable month before.
export const changeOf = (holder: MajorHolder, before: Before) =>
  Effect.sync((): Change | undefined => {
    if (before === undefined) return undefined
    const previous = before.get(holder.key)
    if (previous === undefined) return "new"
    const pp = holder.percentageHundredths - previous.percentageHundredths
    return pp > 0 ? "up" : pp < 0 ? "down" : "unchanged"
  })

const lineOf = Effect.fnUntraced(function* (
  holder: MajorHolder,
  before: Before
) {
  const largest = yield* largestRow(holder)
  const previous = before?.get(holder.key)
  const ppChange =
    previous && holder.percentageHundredths - previous.percentageHundredths
  return {
    key: holder.key,
    name: largest.name,
    controller: yield* controllerOf(holder.rows),
    label: yield* labelOf(largest),
    origin: largest.origin,
    domicile: largest.domicile,
    rows: holder.rows,
    percentageHundredths: holder.percentageHundredths,
    total: holder.total,
    inScrip: holder.total === 0 ? undefined : holder.scrip / holder.total,
    change: yield* changeOf(holder, before),
    ppChange,
    shareChange: previous && holder.total - previous.total,
  } satisfies HolderLine
})

const byPercentage = (lines: ReadonlyArray<HolderLine>) =>
  Effect.succeed(
    [...lines].sort((a, b) => b.percentageHundredths - a.percentageHundredths)
  )

const comparisonOf = (
  months: ReadonlyArray<MajorHoldersMonth>,
  index: number
) =>
  Effect.sync((): Comparison => {
    const before = months[index - 1]
    if (
      before === undefined ||
      months.slice(0, index).every(({ holders }) => holders.length === 0)
    )
      return { kind: "first" }
    return {
      kind: before.holders.length === 0 ? "gap" : "compared",
      dataDate: before.dataDate,
    }
  })

// What month `index` of `months` is compared with, and the month before's
// holders when they are comparable.
export const beforeOf = Effect.fnUntraced(function* (
  months: ReadonlyArray<MajorHoldersMonth>,
  index: number
) {
  const comparison = yield* comparisonOf(months, index)
  const before: Before =
    comparison.kind === "compared"
      ? new Map(months[index - 1]?.holders.map((each) => [each.key, each]))
      : undefined
  return { comparison, before }
})

// The month `month` (`YYYY-MM`) names when the stock has holders in it,
// else its newest such month; undefined when it has none in any.
export const majorHolders = Effect.fnUntraced(function* (
  months: ReadonlyArray<MajorHoldersMonth>,
  month: string | undefined
) {
  const held = months.filter(({ holders }) => holders.length > 0)
  const selected =
    held.find(({ dataDate }) => dataDate.slice(0, 7) === month) ?? held.at(-1)
  if (selected === undefined) return undefined
  const index = months.indexOf(selected)
  const { comparison, before } = yield* beforeOf(months, index)
  const listed = yield* byPercentage(
    yield* Effect.forEach(selected.holders, (each) => lineOf(each, before))
  )
  const keys = new Set(selected.holders.map(({ key }) => key))
  const offList = yield* byPercentage(
    yield* Effect.forEach(
      [...(before?.values() ?? [])].filter(({ key }) => !keys.has(key)),
      (each) =>
        Effect.map(lineOf(each, undefined), (line) => ({
          ...line,
          change: "off list" as const,
        }))
    )
  )
  const counted = (change: Change) =>
    listed.filter((line) => line.change === change).length
  return {
    dataDate: selected.dataDate,
    comparison,
    listed,
    offList,
    totalHundredths: listed.reduce(
      (sum, { percentageHundredths }) => sum + percentageHundredths,
      0
    ),
    counts: before && {
      new: counted("new"),
      up: counted("up"),
      down: counted("down"),
      offList: offList.length,
    },
  } satisfies MonthHolders
})
