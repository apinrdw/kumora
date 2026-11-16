// The Holder size panel's figures for one origin and denominator (spec
// apinrdw/kumora#402, "Holder size panel"): the bar of scrip, ≥5% holders
// and <5% holders, then the same for each KSEI investor type, each as a
// share of the denominator and its change against the month before.
import { Effect } from "effect"

import { KSEI_TYPE_LABELS, KSEI_TYPES, type KseiType } from "@/domain/holdings"
import type {
  HolderSizeMonth,
  InvestorTypeHoldings,
} from "@/server/holdings/stock-page"

import type { OriginShown, SizeBase } from "./stock-search.ts"

export type Holding = NonNullable<HolderSizeMonth["holding"]>

export interface HolderSizeParts {
  // Undefined unless of shares outstanding.
  readonly scrip: number | undefined
  readonly atLeast5: number
  readonly under5: number
}

export interface HolderSizeRow {
  readonly type: KseiType
  readonly label: string
  // Shares of the denominator, 0 to 1.
  readonly atLeast5: number
  readonly under5: number
  // Undefined without a comparable month before.
  readonly atLeast5Change: number | undefined
  readonly under5Change: number | undefined
  // Of the type's own shares, those with ≥5% holders; undefined for a type
  // holding none.
  readonly inAtLeast5: number | undefined
}

export interface HolderSize {
  // The origin and denominator shown: an unsplit month shows all, and local
  // or foreign are of scripless.
  readonly origin: OriginShown
  readonly denominator: SizeBase
  // The denominator's shares.
  readonly base: number
  readonly bar: HolderSizeParts
  // Undefined without a comparable month before.
  readonly changes: HolderSizeParts | undefined
  // All 9 types, most ≥5% first, then most <5%.
  readonly rows: ReadonlyArray<HolderSizeRow>
}

// A month of the Table view: the stock's figures, or why it has none (no row
// in the report, or no local/foreign split under Local or Foreign).
export type HolderSizeColumn =
  | { readonly dataDate: string; readonly shown: "no data" | "unsplit" }
  | HolderSizeFigures

export interface HolderSizeFigures {
  readonly dataDate: string
  readonly shown: "figures"
  readonly bar: HolderSizeParts
  // Each type's ≥5% share of the denominator.
  readonly atLeast5: Readonly<Record<KseiType, number>>
}

export interface HolderSizeTable {
  // As in `HolderSize`; local or foreign only when some month splits.
  readonly origin: OriginShown
  readonly denominator: SizeBase
  readonly columns: ReadonlyArray<HolderSizeColumn>
  // The types holding ≥5% in any column, in KSEI's order.
  readonly atLeast5Types: ReadonlyArray<{
    readonly type: KseiType
    readonly label: string
  }>
}

// `shares` of `total`, 0 to 1; 0 of none.
const ratio = (shares: number, total: number) =>
  Effect.succeed(total === 0 ? 0 : shares / total)

// One month's shares of the denominator, by part and by type.
const shares = Effect.fnUntraced(function* (
  holding: Holding,
  holdings: InvestorTypeHoldings,
  denominator: SizeBase
) {
  const sum = (holders: "under5" | "atLeast5") =>
    KSEI_TYPES.reduce((total, type) => total + holdings[type][holders], 0)
  const scripless = sum("under5") + sum("atLeast5")
  // Decision: scrip never below 0, for a report whose scripless shares pass
  // its shares outstanding, which IDX doesn't rule out.
  const base =
    denominator === "outstanding"
      ? Math.max(holding.sharesOutstanding, scripless)
      : scripless
  const types = new Map<KseiType, { atLeast5: number; under5: number }>()
  for (const type of KSEI_TYPES)
    types.set(type, {
      atLeast5: yield* ratio(holdings[type].atLeast5, base),
      under5: yield* ratio(holdings[type].under5, base),
    })
  return {
    base,
    bar: {
      scrip:
        denominator === "outstanding"
          ? yield* ratio(base - scripless, base)
          : undefined,
      atLeast5: yield* ratio(sum("atLeast5"), base),
      under5: yield* ratio(sum("under5"), base),
    },
    types,
  }
})

const change = (now: number | undefined, before: number | undefined) =>
  Effect.succeed(
    now === undefined || before === undefined ? undefined : now - before
  )

/** `previous` is the report month before, when the stock has a row there. */
export const holderSize = Effect.fnUntraced(function* (
  holding: Holding,
  previous: Holding | undefined,
  asked: OriginShown,
  askedDenominator: SizeBase
): Effect.fn.Return<HolderSize> {
  const origin = holding.local === undefined ? "all" : asked
  const denominator = origin === "all" ? askedDenominator : "scripless"
  // A month before the split has no local or foreign holdings to compare.
  const holdingsOf = (month: Holding) =>
    origin === "all" ? month.combined : month[origin]
  const own = holdingsOf(holding) ?? holding.combined
  const current = yield* shares(holding, own, denominator)
  const previousHoldings =
    previous === undefined ? undefined : holdingsOf(previous)
  const before =
    previous === undefined || previousHoldings === undefined
      ? undefined
      : yield* shares(previous, previousHoldings, denominator)
  const rows: Array<HolderSizeRow> = []
  for (const type of KSEI_TYPES) {
    const now = current.types.get(type)
    const then = before?.types.get(type)
    const held = own[type].atLeast5 + own[type].under5
    rows.push({
      type,
      label: KSEI_TYPE_LABELS[type],
      atLeast5: now?.atLeast5 ?? 0,
      under5: now?.under5 ?? 0,
      atLeast5Change: yield* change(now?.atLeast5, then?.atLeast5),
      under5Change: yield* change(now?.under5, then?.under5),
      inAtLeast5:
        held === 0 ? undefined : yield* ratio(own[type].atLeast5, held),
    })
  }
  rows.sort((a, b) => b.atLeast5 - a.atLeast5 || b.under5 - a.under5)
  return {
    origin,
    denominator,
    base: current.base,
    bar: current.bar,
    changes:
      before === undefined
        ? undefined
        : {
            scrip: yield* change(current.bar.scrip, before.bar.scrip),
            atLeast5: current.bar.atLeast5 - before.bar.atLeast5,
            under5: current.bar.under5 - before.bar.under5,
          },
    rows,
  }
})

const column = Effect.fnUntraced(function* (
  { dataDate, holding }: HolderSizeMonth,
  origin: OriginShown,
  denominator: SizeBase
): Effect.fn.Return<HolderSizeColumn> {
  if (holding === undefined) return { dataDate, shown: "no data" }
  if (origin !== "all" && holding.local === undefined)
    return { dataDate, shown: "unsplit" }
  const figures = yield* holderSize(holding, undefined, origin, denominator)
  return {
    dataDate,
    shown: "figures",
    bar: figures.bar,
    atLeast5: Object.fromEntries(
      figures.rows.map(({ type, atLeast5 }) => [type, atLeast5])
    ) as Record<KseiType, number>,
  }
})

/** The Table view: every month in `months`, oldest first. */
export const holderSizeTable = Effect.fnUntraced(function* (
  months: ReadonlyArray<HolderSizeMonth>,
  asked: OriginShown,
  askedDenominator: SizeBase
): Effect.fn.Return<HolderSizeTable> {
  const origin = months.some(({ split }) => split) ? asked : "all"
  const denominator = origin === "all" ? askedDenominator : "scripless"
  const columns = yield* Effect.forEach(months, (month) =>
    column(month, origin, denominator)
  )
  const held = (type: KseiType) =>
    columns.some((each) => each.shown === "figures" && each.atLeast5[type] > 0)
  return {
    origin,
    denominator,
    columns,
    atLeast5Types: KSEI_TYPES.filter(held).map((type) => ({
      type,
      label: KSEI_TYPE_LABELS[type],
    })),
  }
})
