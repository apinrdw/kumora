// The Major holders panel's holders of one above-1% report month (spec
// apinrdw/kumora#479, "Major holders panel"): the stock's ≥1% holders by %,
// each against the report month before, and those off the list since.
import { Effect } from "effect"

import { CLASSIFICATIONS, KSEI_TYPE_LABELS } from "@/domain/holdings"
import {
  earlierHolders,
  type HolderId,
  holderMoves,
  type Listed,
  mostFirst,
  type Move,
  type MoveRule,
  trendOf,
  type TrendCell,
  type Unlisted,
} from "@/lib/holder-identity"
import type {
  Above1Holder,
  MajorHoldersMonth,
} from "@/server/holdings/stock-page"

type Row = Above1Holder["rows"][number]

export interface HolderLine {
  readonly holder: HolderId
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
  // An off-list holder's are those of its last month.
  readonly percentageHundredths: number
  readonly total: number
  // Scrip ÷ total, 0 to 1; undefined of no shares.
  readonly inScrip: number | undefined
  // Undefined without a comparable month before.
  readonly change: Move | undefined
  // The change of its % against the month before, × 100: up, down or
  // unchanged only.
  readonly percentageChange: number | undefined
  readonly shareChange: number | undefined
  // An earlier holder's: the month after its last listing.
  readonly offListSince: string | undefined
  // Its change in shares over the last months up to this one.
  readonly trend: ReadonlyArray<TrendCell>
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
  // Every earlier holder not listed now nor the month before: the latest
  // off the list first, then most % first.
  readonly history: ReadonlyArray<HolderLine>
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
export const largestRow = (holder: Above1Holder) =>
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

// Major holders' change rule, which the table's chips and the Every month
// grid's marks both follow: the change in summed percentage.
//
// Decision: a holder matches by key, then as returning; a month has no rename
// pass (apps/dashboard/docs/adr/0129-a-renamed-or-returning-holder-keeps-its-identity.md)
const BY_PERCENTAGE: MoveRule<Above1Holder> = {
  change: (before, now) =>
    Effect.succeed(now.percentageHundredths - before.percentageHundredths),
  shares: (holder) => Effect.succeed(holder.total),
}

// Every month's moves, in `months`' order.
export const monthMoves = (months: ReadonlyArray<MajorHoldersMonth>) =>
  holderMoves(
    // A month without the stock has no report for it.
    months.map(({ dataDate, holders }) => ({
      period: dataDate,
      holders: holders.length === 0 ? undefined : holders,
    })),
    BY_PERCENTAGE
  )

const lineOf = Effect.fnUntraced(function* (
  holder: HolderId,
  now: Above1Holder,
  before: Above1Holder | undefined,
  change: Move | undefined,
  offListSince: string | undefined,
  trend: ReadonlyArray<TrendCell>
) {
  const largest = yield* largestRow(now)
  return {
    holder,
    name: largest.name,
    controller: yield* controllerOf(now.rows),
    label: yield* labelOf(largest),
    origin: largest.origin,
    domicile: largest.domicile,
    rows: now.rows,
    percentageHundredths: now.percentageHundredths,
    total: now.total,
    inScrip: now.total === 0 ? undefined : now.scrip / now.total,
    change,
    percentageChange:
      before && now.percentageHundredths - before.percentageHundredths,
    shareChange: before && now.total - before.total,
    offListSince,
    trend,
  } satisfies HolderLine
})

// The report dated `dataDate` when the stock has holders in it, else its
// newest such report; undefined when it has none in any.
export const majorHoldersOn = Effect.fnUntraced(function* (
  months: ReadonlyArray<MajorHoldersMonth>,
  dataDate: string | undefined
) {
  const held = months.filter(({ holders }) => holders.length > 0)
  const selected =
    held.find((each) => each.dataDate === dataDate) ?? held.at(-1)
  if (selected === undefined) return undefined
  const every = yield* monthMoves(months)
  const index = months.indexOf(selected)
  const moves = every[index]
  if (moves === undefined) return undefined
  const trend = (holder: HolderId) =>
    trendOf(every, index, holder, BY_PERCENTAGE)
  const listedLine = Effect.fnUntraced(function* ({
    holder,
    now,
    before,
    move,
  }: Listed<Above1Holder>) {
    return yield* lineOf(
      holder,
      now,
      before,
      move,
      undefined,
      yield* trend(holder)
    )
  })
  const unlistedLine = Effect.fnUntraced(function* (
    { holder, last }: Unlisted<Above1Holder>,
    offListSince: string | undefined
  ) {
    return yield* lineOf(
      holder,
      last,
      undefined,
      "off list",
      offListSince,
      yield* trend(holder)
    )
  })
  const comparison: Comparison =
    moves.comparison.kind === "first"
      ? moves.comparison
      : { kind: moves.comparison.kind, dataDate: moves.comparison.period }
  const listed = yield* mostFirst(
    yield* Effect.forEach(moves.listed, listedLine),
    ({ percentageHundredths }) => percentageHundredths
  )
  const offList = yield* mostFirst(
    yield* Effect.forEach(moves.offList, (each) =>
      unlistedLine(each, undefined)
    ),
    ({ percentageHundredths }) => percentageHundredths
  )
  const unsorted = yield* Effect.forEach(
    yield* earlierHolders(every, index),
    (each) => unlistedLine(each, each.since)
  )
  const history = unsorted.sort(
    (a, b) =>
      (b.offListSince ?? "").localeCompare(a.offListSince ?? "") ||
      b.percentageHundredths - a.percentageHundredths
  )
  const counted = (change: Move) =>
    listed.filter((line) => line.change === change).length
  return {
    dataDate: selected.dataDate,
    comparison,
    listed,
    offList,
    history,
    totalHundredths: listed.reduce(
      (sum, { percentageHundredths }) => sum + percentageHundredths,
      0
    ),
    counts:
      comparison.kind === "compared"
        ? {
            new: counted("new"),
            up: counted("up"),
            down: counted("down"),
            offList: offList.length,
          }
        : undefined,
  } satisfies MonthHolders
})

// The report each calendar month shows, oldest first: its newest that
// holds the stock, since one month can hold two reports; or, of a month
// with none that does, its newest, not `held`. Holder moves' read shows a
// month's newest report (the monthly `periods` in
// server/holdings/holder-moves.ts), and a stock with a line there is in it,
// so a line's link opens the report it came from.
//
// Decision: a calendar month with two reports shows its newest
// (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
export const monthReports = (months: ReadonlyArray<MajorHoldersMonth>) =>
  Effect.sync(() => {
    const reports = new Map<string, { dataDate: string; held: boolean }>()
    for (const { dataDate, holders } of months) {
      const held = holders.length > 0
      const month = dataDate.slice(0, 7)
      if (held || !reports.get(month)?.held)
        reports.set(month, { dataDate, held })
    }
    return [...reports.values()]
  })

// The report the month `month` (`YYYY-MM`) shows (monthReports), as
// majorHoldersOn reads it: the newest held one's for a month that shows
// none with the stock.
export const majorHolders = (
  months: ReadonlyArray<MajorHoldersMonth>,
  month: string | undefined
) =>
  Effect.flatMap(monthReports(months), (reports) =>
    majorHoldersOn(
      months,
      reports.find(
        ({ dataDate, held }) => held && dataDate.slice(0, 7) === month
      )?.dataDate
    )
  )
