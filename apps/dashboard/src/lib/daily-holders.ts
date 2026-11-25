// The Daily holders panel's holders of one parsed above-5% day (spec
// apinrdw/kumora#673, "Holder identity and moves"; apinrdw/kumora#677): the
// stock's above-5% holders, repeat blocks collapsed, each against the trading
// day before by shares, those off the list since, and every earlier holder.
import type { BrokerCode } from "@workspace/relay"
import { Effect } from "effect"

import { brokerOf } from "@/lib/broker-code"
import {
  collapseRepeats,
  type HolderId,
  holderMoves,
  type Listed,
  type Move,
  type MoveRule,
  trendOf,
  type TrendCell,
  type Unlisted,
} from "@/lib/holder-identity"
import type {
  Above5Account,
  Above5Holder,
  DailyHoldersDay,
} from "@/server/holdings/stock-page"

// A holder of one day: its block, and the names of the blocks repeating it.
interface DailyHolder extends Above5Holder {
  readonly aliases: ReadonlyArray<string>
}

export interface AccountLine {
  // Its custodian's broker code; undefined at a bank or other custodian.
  readonly broker: BrokerCode | undefined
  readonly custodian: string
  readonly name: string
  readonly origin: Above5Account["origin"]
  readonly domicile: string | undefined
  readonly shares: number
  // Against its paired account the day before, or from none; undefined
  // when its holder has no listing the day before to pair with.
  readonly shareChange: number | undefined
}

export interface DailyHolderLine {
  readonly holder: HolderId
  readonly name: string
  // The names of its collapsed repeat blocks.
  readonly aliases: ReadonlyArray<string>
  // Its name the day before, when renamed since.
  readonly renamedFrom: string | undefined
  // Mixed when its accounts' origins differ.
  readonly origin: Above5Account["origin"] | "mixed"
  // % of listed shares × 100: before is the day before's, now this day's;
  // absent where it isn't listed. An earlier holder's before is its last.
  readonly stake: { readonly before?: number; readonly now?: number }
  // Its combined shares, or its last listing's when off the list.
  readonly shares: number
  // Undefined without a listing the day before to compare with.
  readonly shareChange: number | undefined
  readonly percentageChange: number | undefined
  // Undefined on the stock's first parsed day.
  readonly move: Move | undefined
  // An earlier holder's: the day after its last listing.
  readonly offListSince: string | undefined
  // The broker codes of the accounts its move went through, largest change
  // first, "custodian" for those without one: on a move, those whose shares
  // changed (a New holder's all, an Off-list holder's all the day before's);
  // none without a move this day.
  readonly through: ReadonlyArray<BrokerCode | "custodian">
  // The last 20 trading days up to the selected one, oldest first.
  readonly trend: ReadonlyArray<TrendCell>
  // Largest first, then those emptied since the day before.
  readonly accounts: ReadonlyArray<AccountLine>
}

export interface HoldersDay {
  readonly dataDate: string
  // The trading day the moves are against; undefined on the stock's first
  // parsed day.
  readonly against: string | undefined
  // The days the picker offers: every parsed day from the stock's first
  // with a holder, oldest first.
  readonly days: ReadonlyArray<string>
  // Listed this day, most % first.
  readonly listed: ReadonlyArray<DailyHolderLine>
  // Listed the day before and not now, most % first.
  readonly offList: ReadonlyArray<DailyHolderLine>
  // Every earlier holder not listed now nor the day before: newest exit
  // first, then most % first.
  readonly history: ReadonlyArray<DailyHolderLine>
  // The listed holders' summed % × 100.
  readonly totalHundredths: number
  // The listed shares in force that day, for the ownership bar.
  readonly listedShares: number | undefined
  // Undefined on the stock's first parsed day.
  readonly counts:
    | {
        readonly new: number
        readonly up: number
        readonly down: number
        readonly offList: number
      }
    | undefined
}

const accountOf = ({ custodian, name }: Above5Account) =>
  `${custodian}\n${name}`

// Decision: a holder matches by key, then as renamed, then as returning
// (apps/dashboard/docs/adr/0129-a-renamed-or-returning-holder-keeps-its-identity.md)
const BY_SHARES: MoveRule<DailyHolder> = {
  change: (before, now) => Effect.succeed(now.scripless - before.scripless),
  shares: (holder) => Effect.succeed(holder.scripless),
  renamed: (gone, arrived) =>
    Effect.sync(() => {
      if (gone.scripless === arrived.scripless) return true
      const accounts = new Set(gone.accounts.map(accountOf))
      return arrived.accounts.some((account) =>
        accounts.has(accountOf(account))
      )
    }),
}

// A block repeats an earlier one of its stock-day when its accounts' names
// and shares, and its combined shares, are the same.
//
// Decision: repeat blocks are stored as published and collapsed on read
// (apps/dashboard/docs/adr/0131-above-5-repeat-blocks-are-stored-as-published.md)
const repeatSignature = ({ scripless, accounts }: Above5Holder) =>
  Effect.sync(() =>
    JSON.stringify([
      scripless,
      accounts.map((account) => [account.name, account.scripless]).sort(),
    ])
  )

const dayHolders = (holders: ReadonlyArray<Above5Holder>) =>
  Effect.map(collapseRepeats(holders, repeatSignature), (collapsed) =>
    collapsed.map(({ holder, aliases }): DailyHolder => ({
      ...holder,
      aliases,
    }))
  )

// Each of `now`'s accounts paired with one of `before`'s by custodian and
// account name, equal shares first, then in order; the rest of `before`
// unpaired.
const pairAccounts = (
  now: ReadonlyArray<Above5Account>,
  before: ReadonlyArray<Above5Account>
) =>
  Effect.sync(() => {
    const left = new Set(before)
    const paired = now.map((): Above5Account | undefined => undefined)
    const pass = (sameShares: boolean) =>
      now.forEach((account, at) => {
        if (paired[at] !== undefined) return
        const match = [...left].find(
          (each) =>
            accountOf(each) === accountOf(account) &&
            (!sameShares || each.scripless === account.scripless)
        )
        if (match === undefined) return
        paired[at] = match
        left.delete(match)
      })
    pass(true)
    pass(false)
    return { paired, emptied: [...left] }
  })

const accountLines = Effect.fnUntraced(function* (
  now: ReadonlyArray<Above5Account>,
  before: ReadonlyArray<Above5Account> | undefined
) {
  const line = (
    account: Above5Account,
    change: number | undefined
  ): Effect.Effect<AccountLine> =>
    Effect.map(brokerOf(account.custodian), (broker) => ({
      broker,
      custodian: account.custodian,
      name: account.name,
      origin: account.origin,
      domicile: account.domicile,
      shares: account.scripless,
      shareChange: change,
    }))
  const largestFirst = (lines: ReadonlyArray<AccountLine>) =>
    [...lines].sort((a, b) => b.shares - a.shares)
  if (before === undefined)
    return largestFirst(
      yield* Effect.forEach(now, (account) => line(account, undefined))
    )
  const { paired, emptied } = yield* pairAccounts(now, before)
  return [
    ...largestFirst(
      yield* Effect.forEach(now, (account, at) =>
        line(account, account.scripless - (paired[at]?.scripless ?? 0))
      )
    ),
    ...(yield* Effect.forEach(emptied, (account) =>
      Effect.map(line(account, -account.scripless), (emptiedLine) => ({
        ...emptiedLine,
        shares: 0,
      }))
    )),
  ]
})

// Each moved account's broker once, at its largest change. An account with
// nothing to pair against (a New holder's, an Off-list holder's last) moved
// its whole holding.
const throughOf = (accounts: ReadonlyArray<AccountLine>) =>
  Effect.sync(() => {
    const moved = accounts
      .map((account) => ({
        account,
        change: Math.abs(account.shareChange ?? account.shares),
      }))
      .filter(({ change }) => change !== 0)
      .sort((a, b) => b.change - a.change)
    return [
      ...new Set(moved.map(({ account }) => account.broker ?? "custodian")),
    ] satisfies DailyHolderLine["through"]
  })

const originOf = (accounts: ReadonlyArray<Above5Account>) =>
  Effect.sync((): DailyHolderLine["origin"] => {
    const origins = new Set(accounts.map(({ origin }) => origin))
    return origins.size > 1
      ? "mixed"
      : origins.has("foreign")
        ? "foreign"
        : "local"
  })

const byPercentage = (
  lines: ReadonlyArray<DailyHolderLine>,
  of: (line: DailyHolderLine) => number | undefined
) => Effect.succeed([...lines].sort((a, b) => (of(b) ?? 0) - (of(a) ?? 0)))

// The day `day` (`YYYY-MM-DD`) names when it is among the stock's days, else
// its newest; undefined when no parsed day has a holder of the stock.
export const dailyHolders = Effect.fnUntraced(function* (
  days: ReadonlyArray<DailyHoldersDay>,
  day: string | undefined
) {
  const first = days.findIndex(({ holders }) => holders.length > 0)
  if (first === -1) return undefined
  const shown = days.slice(first)
  const selected =
    shown.find(({ dataDate }) => dataDate === day) ?? shown.at(-1)
  if (selected === undefined) return undefined
  const index = days.indexOf(selected)
  const periods = yield* Effect.forEach(days, ({ dataDate, holders }) =>
    Effect.map(dayHolders(holders), (collapsed) => ({
      period: dataDate,
      holders: collapsed,
    }))
  )
  const moves = yield* holderMoves(periods, BY_SHARES)
  const selectedMoves = moves[index]
  if (selectedMoves === undefined) return undefined
  const trend = (holder: HolderId) => trendOf(moves, index, holder, BY_SHARES)
  const compared = selectedMoves.comparison.kind === "compared"

  const listedLine = Effect.fnUntraced(function* ({
    holder,
    now,
    before,
    move,
    renamed,
  }: Listed<DailyHolder>) {
    const accounts = yield* accountLines(now.accounts, before?.accounts)
    return {
      holder,
      name: now.name,
      aliases: now.aliases,
      renamedFrom: renamed ? before?.name : undefined,
      origin: yield* originOf(now.accounts),
      stake: {
        ...(before && { before: before.percentageHundredths }),
        now: now.percentageHundredths,
      },
      shares: now.scripless,
      shareChange: before && now.scripless - before.scripless,
      percentageChange:
        before && now.percentageHundredths - before.percentageHundredths,
      move,
      offListSince: undefined,
      through: move === undefined ? [] : yield* throughOf(accounts),
      trend: yield* trend(holder),
      accounts,
    } satisfies DailyHolderLine
  })

  const unlistedLine = Effect.fnUntraced(function* (
    { holder, last }: Unlisted<DailyHolder>,
    offListSince: string | undefined
  ) {
    const accounts = yield* accountLines(last.accounts, undefined)
    return {
      holder,
      name: last.name,
      aliases: last.aliases,
      renamedFrom: undefined,
      origin: yield* originOf(last.accounts),
      stake: { before: last.percentageHundredths },
      shares: last.scripless,
      shareChange: undefined,
      percentageChange: undefined,
      move: "off list",
      offListSince,
      // Only the day's Off list moved this day; an earlier holder left before.
      through: offListSince === undefined ? yield* throughOf(accounts) : [],
      trend: yield* trend(holder),
      accounts,
    } satisfies DailyHolderLine
  })

  const listed = yield* byPercentage(
    yield* Effect.forEach(selectedMoves.listed, listedLine),
    ({ stake }) => stake.now
  )
  const offList = yield* byPercentage(
    yield* Effect.forEach(selectedMoves.offList, (each) =>
      unlistedLine(each, undefined)
    ),
    ({ stake }) => stake.before
  )
  const history = (yield* Effect.forEach(selectedMoves.history, (each) =>
    unlistedLine(each, each.since)
  )).sort(
    (a, b) =>
      (b.offListSince ?? "").localeCompare(a.offListSince ?? "") ||
      (b.stake.before ?? 0) - (a.stake.before ?? 0)
  )
  const counted = (move: Move) =>
    listed.filter((line) => line.move === move).length
  return {
    dataDate: selected.dataDate,
    against:
      selectedMoves.comparison.kind === "first"
        ? undefined
        : selectedMoves.comparison.period,
    days: shown.map(({ dataDate }) => dataDate),
    listed,
    offList,
    history,
    totalHundredths: listed.reduce(
      (sum, { stake }) => sum + (stake.now ?? 0),
      0
    ),
    listedShares: selected.listedShares,
    counts: compared
      ? {
          new: counted("new"),
          up: counted("up"),
          down: counted("down"),
          offList: offList.length,
        }
      : undefined,
  } satisfies HoldersDay
})
