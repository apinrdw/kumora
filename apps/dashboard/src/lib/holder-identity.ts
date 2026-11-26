// Holder identity and moves across periods of one stock (spec
// apinrdw/kumora#673, "Holder identity and moves"), shared by Major holders,
// Daily holders and Holder moves. A period is a month or a trading day; this
// module never reads which.
import { Effect } from "effect"

import { TREND_PERIODS } from "@/domain/holdings"

// Against the period before: absent from it (new), from this one (off list),
// else up, down or unchanged by the caller's rule, an unchanged one a
// transfer when the rule finds one.
export type Move = "new" | "up" | "down" | "transfer" | "unchanged" | "off list"

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
  // Whether a holder `change` finds unchanged moved its shares elsewhere,
  // a Transfer. Without it none is.
  readonly transferred?: (before: H, now: H) => Effect.Effect<boolean>
}

// What a period's moves are against: the period before, or why there are
// none (the stock's first period, or the period before has no holders).
type PeriodComparison =
  | { readonly kind: "compared" | "gap"; readonly period: string }
  | { readonly kind: "first" }

// A period's holder given its identity.
interface Identified<H> {
  readonly holder: HolderId
  readonly now: H
  // Listed the period before under another key.
  readonly renamed: boolean
  // Listed in an earlier period, not the one before.
  readonly returning: boolean
}

export interface Listed<H> extends Identified<H> {
  // Its listing in the period before, when compared and listed there.
  readonly before: H | undefined
  // Undefined without a comparable period before.
  readonly move: Exclude<Move, "off list"> | undefined
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
}

// Each period's holders given identities, in its order. A holder takes the
// identity of the first same-key holder of the period before not yet taken
// (so same-key holders are told apart by order); else, by the rule's rename
// test, of a holder of the period before left unmatched; else of an earlier
// same-key holder not listed the period before (a return); else a new one.
//
// Decision: a holder matches by key, then as renamed, then as returning
// (apps/dashboard/docs/adr/0129-a-renamed-or-returning-holder-keeps-its-identity.md)
const identities = Effect.fnUntraced(function* <
  H extends { readonly key: string },
>(periods: ReadonlyArray<HolderPeriod<H>>, rule: MoveRule<H>) {
  const issued = new Map<string, Array<HolderId>>()
  let previous: ReadonlyArray<Identified<H>> = []
  const out: Array<ReadonlyArray<Identified<H>>> = []
  for (const { holders = [] } of periods) {
    const taken = new Set<HolderId>()
    const byKey = yield* keyMatches(holders, previous, taken)
    const renamed = yield* renames(holders, byKey, previous, taken, rule)
    previous = yield* settle(holders, byKey, renamed, issued, previous, taken)
    out.push(previous)
  }
  return out
})

// Each holder's identity by key in the period before, the first not yet
// taken; undefined when none. It reads the keys the period before listed,
// not every key an identity was ever listed under: after A is renamed B, a
// new A must not take B's identity.
const keyMatches = <H extends { readonly key: string }>(
  holders: ReadonlyArray<H>,
  previous: ReadonlyArray<Identified<H>>,
  taken: Set<HolderId>
) =>
  Effect.sync(() =>
    holders.map(({ key }): HolderId | undefined => {
      const match = previous.find(
        ({ holder, now }) => now.key === key && !taken.has(holder)
      )
      if (match !== undefined) taken.add(match.holder)
      return match?.holder
    })
  )

// Fills `ids` in place for the unmatched holders the rule finds renamed from
// a holder of the period before not yet taken; whether each holder was.
const renames = Effect.fnUntraced(function* <H>(
  holders: ReadonlyArray<H>,
  ids: Array<HolderId | undefined>,
  previous: ReadonlyArray<Identified<H>>,
  taken: Set<HolderId>,
  rule: MoveRule<H>
) {
  const renamed = holders.map(() => false)
  const isRename = rule.renamed
  if (isRename === undefined) return renamed
  for (const [at, holder] of holders.entries()) {
    if (ids[at] !== undefined) continue
    const gone = previous.filter((each) => !taken.has(each.holder))
    const match = yield* Effect.findFirst(gone, (each) =>
      isRename(each.now, holder)
    )
    if (match._tag === "None") continue
    ids[at] = match.value.holder
    renamed[at] = true
    taken.add(match.value.holder)
  }
  return renamed
})

// The holders with their identities, the rest's settled: an earlier
// same-key holder's not listed the period before (a return), else a new
// one. Records every identity under its key.
const settle = <H extends { readonly key: string }>(
  holders: ReadonlyArray<H>,
  ids: ReadonlyArray<HolderId | undefined>,
  renamed: ReadonlyArray<boolean>,
  issued: Map<string, Array<HolderId>>,
  previous: ReadonlyArray<Identified<H>>,
  taken: Set<HolderId>
) =>
  Effect.sync(() => {
    const before = new Set(previous.map(({ holder }) => holder))
    return holders.map((now, at): Identified<H> => {
      const ofKey = issued.get(now.key) ?? []
      const back =
        ids[at] === undefined
          ? ofKey.find((each) => !before.has(each) && !taken.has(each))
          : undefined
      const holder =
        ids[at] ?? back ?? (`${now.key}#${ofKey.length + 1}` as HolderId)
      if (!ofKey.includes(holder)) issued.set(now.key, [...ofKey, holder])
      taken.add(holder)
      return {
        holder,
        now,
        renamed: renamed[at] ?? false,
        returning: back !== undefined,
      }
    })
  })

// A holder's move by `rule`: a Transfer only when its total is unchanged.
//
// Decision: a Transfer is shares crossing brokers with the total unchanged
// (apps/dashboard/docs/adr/0135-a-transfer-is-shares-crossing-brokers-with-the-total-unchanged.md)
const moveOf = Effect.fnUntraced(function* <H>(
  before: H,
  now: H,
  rule: MoveRule<H>
): Effect.fn.Return<"up" | "down" | "transfer" | "unchanged"> {
  const change = yield* rule.change(before, now)
  if (change !== 0) return change > 0 ? "up" : "down"
  return rule.transferred !== undefined &&
    (yield* rule.transferred(before, now))
    ? "transfer"
    : "unchanged"
})

// What a period's moves are against, from the period before it and whether
// any period before it has a report.
const comparisonOf = <H>(
  earlier: HolderPeriod<H> | undefined,
  reported: boolean
) =>
  Effect.succeed<PeriodComparison>(
    earlier === undefined || !reported
      ? { kind: "first" }
      : {
          kind: earlier.holders === undefined ? "gap" : "compared",
          period: earlier.period,
        }
  )

// A period's holders, each against its listing in the compared period
// before, `before` by identity; undefined without one.
const listedOf = <H>(
  holders: ReadonlyArray<Identified<H>>,
  before: ReadonlyMap<HolderId, H> | undefined,
  rule: MoveRule<H>
) =>
  Effect.forEach(
    holders,
    Effect.fnUntraced(function* (identified) {
      const last = before?.get(identified.holder)
      return {
        ...identified,
        before: last,
        move:
          before === undefined
            ? undefined
            : last === undefined
              ? "new"
              : yield* moveOf(last, identified.now, rule),
      } satisfies Listed<H>
    })
  )

// Every period's moves, in `periods`' order. What it keeps grows with the
// periods' holders, not with periods × holders: a period's moves hold its
// own holders and the period before's, and its earlier holders are worked
// out for one period at a time (earlierHolders).
export const holderMoves = Effect.fnUntraced(function* <
  H extends { readonly key: string },
>(periods: ReadonlyArray<HolderPeriod<H>>, rule: MoveRule<H>) {
  const identified = yield* identities(periods, rule)
  let reported = false
  const moves: Array<PeriodMoves<H>> = []
  for (const [index, { period, holders }] of periods.entries()) {
    const comparison = yield* comparisonOf(periods[index - 1], reported)
    const mine = identified[index] ?? []
    const before =
      comparison.kind === "compared"
        ? new Map(
            (identified[index - 1] ?? []).map(({ holder, now }) => [
              holder,
              now,
            ])
          )
        : undefined
    const now = new Set(mine.map(({ holder }) => holder))
    moves.push({
      period,
      comparison,
      listed: yield* listedOf(mine, before, rule),
      offList: [...(before ?? [])]
        .filter(([holder]) => !now.has(holder))
        .map(([holder, last]) => ({ holder, last, since: period })),
    })
    reported ||= holders !== undefined
  }
  return moves
})

// The earlier holders of the period at `index` of `moves`: listed in any
// period before it, not in it, and not on its Off list. The latest off the
// list first, then in the order of that last listing.
export const earlierHolders = <H>(
  moves: ReadonlyArray<PeriodMoves<H>>,
  index: number
) =>
  Effect.sync((): ReadonlyArray<Unlisted<H>> => {
    const shown = new Set(
      [...(moves[index]?.listed ?? []), ...(moves[index]?.offList ?? [])].map(
        ({ holder }) => holder
      )
    )
    // Each identity's latest listing before the period: its holder, period
    // index and place in that period.
    const last = new Map<
      HolderId,
      { readonly holder: H; readonly at: number; readonly place: number }
    >()
    for (const [at, { listed }] of moves.slice(0, index).entries())
      for (const [place, { holder, now }] of listed.entries())
        last.set(holder, { holder: now, at, place })
    return [...last]
      .filter(([holder]) => !shown.has(holder))
      .sort(([, a], [, b]) => b.at - a.at || a.place - b.place)
      .flatMap(([holder, seen]) => {
        const since = moves[seen.at + 1]
        return since ? [{ holder, last: seen.holder, since: since.period }] : []
      })
  })

// A trend's period: the change in shares on the period before, "in" where
// the holder entered the list and "out" where it left, "transfer" where
// its shares moved elsewhere unchanged, null where none is known (not
// listed, or no comparable period before).
export type TrendCell = number | "in" | "out" | "transfer" | null

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
      if (listed.move === "transfer") return "transfer"
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

// `lines` with the most % first, by `of`; none counts as 0.
export const mostFirst = <L>(
  lines: ReadonlyArray<L>,
  of: (line: L) => number | undefined
) => Effect.sync(() => [...lines].sort((a, b) => (of(b) ?? 0) - (of(a) ?? 0)))
