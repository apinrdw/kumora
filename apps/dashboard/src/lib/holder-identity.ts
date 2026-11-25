// Holder identity and moves across periods of one stock (spec
// apinrdw/kumora#673, "Holder identity and moves"), shared by Major holders,
// Daily holders and Holder moves. A period is a month or a trading day; this
// module never reads which.
import { Effect } from "effect"

// Against the period before: absent from it (new), from this one (off list),
// else up, down or unchanged by the caller's rule.
export type Move = "new" | "up" | "down" | "unchanged" | "off list"

// A holder's identity across a stock's periods, through returns: the same
// investor's listings in every period share one.
export type HolderId = string & { readonly HolderId: unique symbol }

// One period of a stock's holders, in the report's order. A period with no
// holders has no report for the stock: nothing compares across it.
export interface HolderPeriod<H> {
  readonly period: string
  readonly holders: ReadonlyArray<H>
}

export interface MoveRule<H> {
  // Positive when `now` is up on `before`, negative when down, 0 unchanged.
  readonly change: (before: H, now: H) => Effect.Effect<number>
  // What a trend's bar counts.
  readonly shares: (holder: H) => Effect.Effect<number>
}

// What a period's moves are against: the period before, or why there are
// none (the stock's first period, or the period before has no holders).
type PeriodComparison =
  | { readonly kind: "compared" | "gap"; readonly period: string }
  | { readonly kind: "first" }

export interface Listed<H> {
  readonly holder: HolderId
  readonly now: H
  // Its listing in the period before, when compared and listed there.
  readonly before: H | undefined
  // Undefined without a comparable period before.
  readonly move: Exclude<Move, "off list"> | undefined
  // Listed in an earlier period, not the one before.
  readonly returning: boolean
}

// A holder off the list in a period: its last listing, and the period after
// it, since which it is off the list.
export interface Unlisted<H> {
  readonly holder: HolderId
  readonly last: H
  readonly since: string
}

export interface PeriodMoves<H> {
  readonly period: string
  readonly comparison: PeriodComparison
  // In the period's order.
  readonly listed: ReadonlyArray<Listed<H>>
  // Listed in the compared period before and not now, in its order.
  readonly offList: ReadonlyArray<Unlisted<H>>
  // Listed in any earlier period, not now, and not this period's Off list:
  // newest exit first, then in the order of that last listing.
  readonly history: ReadonlyArray<Unlisted<H>>
}

const comparisonOf = <H>(
  periods: ReadonlyArray<HolderPeriod<H>>,
  index: number
) =>
  Effect.sync((): PeriodComparison => {
    const before = periods[index - 1]
    if (
      before === undefined ||
      periods.slice(0, index).every(({ holders }) => holders.length === 0)
    )
      return { kind: "first" }
    return {
      kind: before.holders.length === 0 ? "gap" : "compared",
      period: before.period,
    }
  })

// Each period's holders given identities. A holder takes the identity of the
// first same-key holder of the period before not yet taken (so same-key
// holders are told apart by order), else of an earlier same-key holder not
// listed the period before (a return), else a new one.
//
// Decision: a holder matches the period before by key; a returning one
// rejoins its history (apps/dashboard/docs/adr/0129-a-returning-holder-rejoins-its-history.md)
const identities = <H extends { readonly key: string }>(
  periods: ReadonlyArray<HolderPeriod<H>>
) =>
  Effect.sync(() => {
    const issued = new Map<string, Array<HolderId>>()
    let previous = new Set<HolderId>()
    return periods.map(({ holders }) => {
      const taken = new Set<HolderId>()
      const ids = holders.map(({ key }) => {
        const ofKey = issued.get(key) ?? []
        const id =
          ofKey.find((each) => previous.has(each) && !taken.has(each)) ??
          ofKey.find((each) => !previous.has(each) && !taken.has(each)) ??
          (`${key}#${ofKey.length + 1}` as HolderId)
        if (!ofKey.includes(id)) issued.set(key, [...ofKey, id])
        taken.add(id)
        return id
      })
      previous = taken
      return ids
    })
  })

const moveOf = (change: number) =>
  Effect.succeed<"up" | "down" | "unchanged">(
    change > 0 ? "up" : change < 0 ? "down" : "unchanged"
  )

// Every period's moves, in `periods`' order.
export const holderMoves = Effect.fnUntraced(function* <
  H extends { readonly key: string },
>(periods: ReadonlyArray<HolderPeriod<H>>, rule: MoveRule<H>) {
  const ids = yield* identities(periods)
  // Each identity's latest listing so far: its holder, period index and
  // place in that period.
  const last = new Map<
    HolderId,
    { readonly holder: H; readonly at: number; readonly place: number }
  >()
  const unlisted = (id: HolderId) =>
    Effect.sync((): Unlisted<H> | undefined => {
      const seen = last.get(id)
      const since = seen && periods[seen.at + 1]
      return (
        seen &&
        since && {
          holder: id,
          last: seen.holder,
          since: since.period,
        }
      )
    })
  return yield* Effect.forEach(
    periods,
    Effect.fnUntraced(function* ({ period, holders }, index) {
      const comparison = yield* comparisonOf(periods, index)
      const mine = ids[index] ?? []
      const before =
        comparison.kind === "compared"
          ? new Map(
              (ids[index - 1] ?? []).map((id, at) => [
                id,
                periods[index - 1]?.holders[at],
              ])
            )
          : undefined
      const listed = yield* Effect.forEach(
        holders,
        Effect.fnUntraced(function* (now, at) {
          const holder = mine[at] as HolderId
          const previous = before?.get(holder)
          return {
            holder,
            now,
            before: previous,
            move:
              before === undefined
                ? undefined
                : previous === undefined
                  ? "new"
                  : yield* moveOf(yield* rule.change(previous, now)),
            returning:
              last.has(holder) && !(ids[index - 1] ?? []).includes(holder),
          } satisfies Listed<H>
        })
      )
      const now = new Set(mine)
      const offIds = [...(before?.keys() ?? [])].filter((id) => !now.has(id))
      const offList = yield* Effect.forEach(offIds, unlisted)
      const away = [...last]
        .filter(([id]) => !now.has(id) && !offIds.includes(id))
        .sort(([, a], [, b]) => b.at - a.at || a.place - b.place)
      const history = yield* Effect.forEach(away, ([id]) => unlisted(id))
      mine.forEach((id, place) =>
        last.set(id, { holder: holders[place] as H, at: index, place })
      )
      return {
        period,
        comparison,
        listed,
        offList: offList.filter((each) => each !== undefined),
        history: history.filter((each) => each !== undefined),
      } satisfies PeriodMoves<H>
    })
  )
})

// A trend's period: the change in shares on the period before, "in" where
// the holder entered the list and "out" where it left, null where neither
// is known (not listed, or no comparable period before).
type TrendCell = number | "in" | "out" | null

const TREND_PERIODS = 20

// `holder`'s trend over the TREND_PERIODS periods ending at `index` of
// `moves`, oldest first; fewer when the stock has fewer.
export const trendOf = Effect.fnUntraced(function* <H>(
  moves: ReadonlyArray<PeriodMoves<H>>,
  index: number,
  holder: HolderId,
  rule: MoveRule<H>
) {
  return yield* Effect.forEach(
    moves.slice(Math.max(0, index - TREND_PERIODS + 1), index + 1),
    Effect.fnUntraced(function* (period): Effect.fn.Return<TrendCell> {
      const listed = period.listed.find((each) => each.holder === holder)
      if (listed?.move === undefined)
        return period.offList.some((each) => each.holder === holder)
          ? "out"
          : null
      if (listed.before === undefined) return "in"
      return (
        (yield* rule.shares(listed.now)) - (yield* rule.shares(listed.before))
      )
    })
  )
})
