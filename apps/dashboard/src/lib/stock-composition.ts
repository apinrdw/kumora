// The Shareholders composition panel's rows for one origin (spec
// apinrdw/kumora#363, stories 16–27): each KSEI investor type, or each
// investor classification, with its shares, its share of the origin, and
// the same share the month before.
import { Effect } from "effect"

import {
  CLASSIFICATIONS,
  KSEI_TYPE_LABELS,
  type KseiType,
} from "@/domain/holdings"
import type { CompositionMonth } from "@/server/holdings/stock-page"

import type { OriginShown } from "./stock-search.ts"

export interface CompositionRow {
  readonly key: string
  readonly label: string
  readonly type: KseiType
  readonly shares: number
  // Of the origin's total, 0 to 1.
  readonly share: number
  // Undefined when the month before has no figure for this origin.
  readonly previousShare: number | undefined
}

export interface Composition {
  // The origin's total scripless shares.
  readonly total: number
  // Largest first; only rows holding shares this month or the month before.
  readonly rows: ReadonlyArray<CompositionRow>
  // The Individual type's share: retail. The rest is institution.
  readonly retail: number
}

export type Level = "types" | "classifications"

const keyed = (month: CompositionMonth, level: Level) =>
  Effect.succeed(
    level === "types"
      ? month.types.map((held) => ({
          key: held.type as string,
          label: KSEI_TYPE_LABELS[held.type],
          type: held.type,
          held,
        }))
      : month.types.flatMap(({ classifications }) =>
          classifications.map((held) => ({
            key: held.classification as string,
            label: CLASSIFICATIONS[held.classification].label,
            type: CLASSIFICATIONS[held.classification].type,
            held,
          }))
        )
  )

// Each row's shares of the origin, and their total.
const sharesOf = Effect.fnUntraced(function* (
  month: CompositionMonth,
  origin: OriginShown,
  level: Level
) {
  const rows = (yield* keyed(month, level)).map(({ held, ...row }) => ({
    ...row,
    shares: (origin === "all" ? held.combined : held[origin]) ?? 0,
  }))
  const total = rows.reduce((sum, { shares }) => sum + shares, 0)
  return { rows, total }
})

// `shares` of `total`, 0 to 1; 0 of none.
const ratio = (shares: number, total: number) =>
  Effect.succeed(total === 0 ? 0 : shares / total)

/** `origin` is local or foreign only for a month that splits them. */
export const composition = Effect.fnUntraced(function* (
  month: CompositionMonth,
  previous: CompositionMonth | undefined,
  origin: OriginShown,
  level: Level
): Effect.fn.Return<Composition> {
  const current = yield* sharesOf(month, origin, level)
  // The month before has no figure for local or foreign before the split.
  const before =
    previous === undefined || (origin !== "all" && !previous.split)
      ? undefined
      : yield* sharesOf(previous, origin, level)
  const previousShares = new Map(
    before?.rows.map(({ key, shares }) => [key, shares])
  )
  // The read model lists no classification holding nothing, so one the
  // month before held comes from that month, at 0 shares now.
  const shown = new Map(current.rows.map((row) => [row.key, row]))
  for (const row of before?.rows ?? [])
    if (!shown.has(row.key)) shown.set(row.key, { ...row, shares: 0 })
  const rows: Array<CompositionRow> = []
  for (const { key, label, type, shares } of shown.values()) {
    const previousHeld = previousShares.get(key) ?? 0
    // A row that sold out since the month before stays, to read `3% → 0%`.
    if (shares === 0 && previousHeld === 0) continue
    rows.push({
      key,
      label,
      type,
      shares,
      share: yield* ratio(shares, current.total),
      previousShare:
        before === undefined
          ? undefined
          : yield* ratio(previousHeld, before.total),
    })
  }
  rows.sort((a, b) => b.shares - a.shares)
  const retail = rows
    .filter(({ type }) => type === "ID")
    .reduce((sum, { share }) => sum + share, 0)
  return { total: current.total, rows, retail }
})

// The share of the stock's listed shares held as scrip (listed − scripless),
// 0 to 1, or why there is none: KSEI has no listed shares for the month's
// date, or fewer than its scripless shares, so a wrong scrip share is never
// shown.
export type Scrip =
  | { readonly _tag: "Share"; readonly share: number }
  | { readonly _tag: "NoListedShares" }
  | { readonly _tag: "FewerListed"; readonly listedShares: number }

export const scrip = ({
  listedShares,
  totalScripless,
}: CompositionMonth): Effect.Effect<Scrip> =>
  Effect.succeed(
    listedShares === undefined
      ? { _tag: "NoListedShares" }
      : listedShares < totalScripless
        ? { _tag: "FewerListed", listedShares }
        : {
            _tag: "Share",
            share: (listedShares - totalScripless) / listedShares,
          }
  )
