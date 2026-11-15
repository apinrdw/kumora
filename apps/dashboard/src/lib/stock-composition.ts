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

// Each row's shares of the origin, and their total.
const sharesOf = (
  month: CompositionMonth,
  origin: OriginShown,
  level: Level
) => {
  const rows = keyed(month, level).map(({ held, ...row }) => ({
    ...row,
    shares: (origin === "all" ? held.combined : held[origin]) ?? 0,
  }))
  const total = rows.reduce((sum, { shares }) => sum + shares, 0)
  return { rows, total }
}

const ratio = (shares: number, total: number) =>
  total === 0 ? 0 : shares / total

/** `origin` is local or foreign only for a month that splits them. */
export const composition = (
  month: CompositionMonth,
  previous: CompositionMonth | undefined,
  origin: OriginShown,
  level: Level
): Effect.Effect<Composition> =>
  Effect.sync(() => {
    const current = sharesOf(month, origin, level)
    // The month before has no figure for local or foreign before the split.
    const before =
      previous === undefined || (origin !== "all" && !previous.split)
        ? undefined
        : sharesOf(previous, origin, level)
    const previousShares = new Map(
      before?.rows.map(({ key, shares }) => [key, shares])
    )
    // A row that sold out since the month before stays, to read `3% → 0%`.
    const rows = current.rows
      .filter(
        ({ key, shares }) => shares > 0 || (previousShares.get(key) ?? 0) > 0
      )
      .map(({ key, label, type, shares }): CompositionRow => ({
        key,
        label,
        type,
        shares,
        share: ratio(shares, current.total),
        previousShare:
          before === undefined
            ? undefined
            : ratio(previousShares.get(key) ?? 0, before.total),
      }))
      .sort((a, b) => b.shares - a.shares)
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
