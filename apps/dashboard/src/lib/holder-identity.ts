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

// One period of a stock's holders, in the report's order. Undefined holders
// mean no report for the stock: nothing compares across it. None means a
// report with no holder of it, so everyone before is off the list.
export interface HolderPeriod<H> {
  readonly period: string
  readonly holders: ReadonlyArray<H> | undefined
}

export interface MoveRule<H> {
  // Positive when `now` is up on `before`, negative when down, 0 unchanged.
  readonly change: (before: H, now: H) => Effect.Effect<number>
  // What a trend's bar counts.
  readonly shares: (holder: H) => Effect.Effect<number>
  // Whether a holder gone since the period before and one new in this
  // period, neither matched by key, are one holder renamed. Without it a
  // holder matches by key only.
  readonly renamed?: (gone: H, arrived: H) => Effect.Effect<boolean>
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
  // Listed the period before under another key.
  readonly renamed: boolean
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
      periods.slice(0, index).every(({ holders }) => holders === undefined)
    )
      return { kind: "first" }
    return {
      kind: before.holders === undefined ? "gap" : "compared",
      period: before.period,
    }
  })

// Each period's holders given identities, and whether each is renamed. A
// holder takes the identity of the first same-key holder of the period
// before not yet taken (so same-key holders are told apart by order); else,
// by the rule's rename test, of a holder of the period before left
// unmatched; else of an earlier same-key holder not listed the period
// before (a return); else a new one.
//
// Decision: a holder matches by key, then as renamed, then as returning
// (apps/dashboard/docs/adr/0129-a-renamed-or-returning-holder-keeps-its-identity.md)
const identities = Effect.fnUntraced(function* <
  H extends { readonly key: string },
>(periods: ReadonlyArray<HolderPeriod<H>>, rule: MoveRule<H>) {
  const issued = new Map<string, Array<HolderId>>()
  let previous: ReadonlyArray<readonly [HolderId, H]> = []
  const out: Array<{
    readonly ids: ReadonlyArray<HolderId>
    readonly renamed: ReadonlyArray<boolean>
  }> = []
  for (const { holders = [] } of periods) {
    const before = new Set(previous.map(([id]) => id))
    const taken = new Set<HolderId>()
    const byKey = yield* keyMatches(holders, issued, before, taken)
    const renamed = yield* renames(holders, byKey, previous, taken, rule)
    const ids = yield* settle(holders, byKey, issued, before, taken)
    previous = ids.map((id, at) => [id, holders[at] as H] as const)
    out.push({ ids, renamed })
  }
  return out
})

// Each holder's identity by key in the period before, the first not yet
// taken; undefined when none.
const keyMatches = <H extends { readonly key: string }>(
  holders: ReadonlyArray<H>,
  issued: ReadonlyMap<string, ReadonlyArray<HolderId>>,
  before: ReadonlySet<HolderId>,
  taken: Set<HolderId>
) =>
  Effect.sync(() =>
    holders.map(({ key }): HolderId | undefined => {
      const id = issued
        .get(key)
        ?.find((each) => before.has(each) && !taken.has(each))
      if (id !== undefined) taken.add(id)
      return id
    })
  )

// Fills `ids` in place for the unmatched holders the rule finds renamed from
// a holder of the period before not yet taken; whether each holder was.
const renames = Effect.fnUntraced(function* <H>(
  holders: ReadonlyArray<H>,
  ids: Array<HolderId | undefined>,
  previous: ReadonlyArray<readonly [HolderId, H]>,
  taken: Set<HolderId>,
  rule: MoveRule<H>
) {
  const renamed = holders.map(() => false)
  const isRename = rule.renamed
  if (isRename === undefined) return renamed
  for (const [at, holder] of holders.entries()) {
    if (ids[at] !== undefined) continue
    const gone = previous.filter(([id]) => !taken.has(id))
    const match = yield* Effect.findFirst(gone, ([, each]) =>
      isRename(each, holder)
    )
    if (match._tag === "None") continue
    const [id] = match.value
    ids[at] = id
    renamed[at] = true
    taken.add(id)
  }
  return renamed
})

// The rest's identities: an earlier same-key holder's not listed the period
// before (a return), else a new one. Records every identity under its key.
const settle = <H extends { readonly key: string }>(
  holders: ReadonlyArray<H>,
  ids: ReadonlyArray<HolderId | undefined>,
  issued: Map<string, Array<HolderId>>,
  before: ReadonlySet<HolderId>,
  taken: Set<HolderId>
) =>
  Effect.sync(() =>
    holders.map(({ key }, at) => {
      const ofKey = issued.get(key) ?? []
      const id =
        ids[at] ??
        ofKey.find((each) => !before.has(each) && !taken.has(each)) ??
        (`${key}#${ofKey.length + 1}` as HolderId)
      if (!ofKey.includes(id)) issued.set(key, [...ofKey, id])
      taken.add(id)
      return id
    })
  )

const moveOf = (change: number) =>
  Effect.succeed<"up" | "down" | "unchanged">(
    change > 0 ? "up" : change < 0 ? "down" : "unchanged"
  )

// Every period's moves, in `periods`' order.
export const holderMoves = Effect.fnUntraced(function* <
  H extends { readonly key: string },
>(periods: ReadonlyArray<HolderPeriod<H>>, rule: MoveRule<H>) {
  const identified = yield* identities(periods, rule)
  const ids = identified.map((period) => period.ids)
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
    Effect.fnUntraced(function* ({ period, holders = [] }, index) {
      const comparison = yield* comparisonOf(periods, index)
      const mine = ids[index] ?? []
      const before =
        comparison.kind === "compared"
          ? new Map(
              (ids[index - 1] ?? []).map((id, at) => [
                id,
                periods[index - 1]?.holders?.[at],
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
            renamed: identified[index]?.renamed[at] ?? false,
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
export type TrendCell = number | "in" | "out" | null

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

// A period's holders with each block that repeats an earlier one (the same
// signature) folded into it, the repeat's name an alias when it differs.
export const collapseRepeats = Effect.fnUntraced(function* <
  H extends { readonly name: string },
>(holders: ReadonlyArray<H>, signature: (holder: H) => Effect.Effect<string>) {
  const bySignature = new Map<
    string,
    { readonly holder: H; readonly aliases: Array<string> }
  >()
  for (const holder of holders) {
    const mark = yield* signature(holder)
    const first = bySignature.get(mark)
    if (first === undefined) bySignature.set(mark, { holder, aliases: [] })
    else if (
      holder.name !== first.holder.name &&
      !first.aliases.includes(holder.name)
    )
      first.aliases.push(holder.name)
  }
  return [...bySignature.values()]
})
