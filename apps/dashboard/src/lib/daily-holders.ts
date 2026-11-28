// The Daily holders panel's holders of one parsed above-5% day (spec
// apinrdw/kumora#673, "Holder identity and moves"; apinrdw/kumora#677): the
// stock's above-5% holders, repeat blocks collapsed, each against the trading
// day before by shares, those off the list since, and every earlier holder.
import type { BrokerCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { brokerOf } from "@/lib/broker-code"
import {
  collapseRepeats,
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
  Above5SecuritiesAccount,
  Above5Holder,
  DailyHoldersDay,
} from "@/server/holdings/stock-page"

// A holder of one day: its block, and the names of the blocks repeating it.
interface DailyHolder extends Above5Holder {
  readonly aliases: ReadonlyArray<string>
}

export interface SecuritiesAccountLine {
  // Its custodian's broker code; undefined at a bank or other custodian.
  readonly broker: BrokerCode | undefined
  readonly custodian: string
  readonly name: string
  readonly origin: Above5SecuritiesAccount["origin"]
  readonly domicile: string | undefined
  readonly shares: number
  // Against its paired securities account the day before, or from none;
  // undefined when its holder has no listing the day before to pair with.
  readonly shareChange: number | undefined
}

export interface DailyHolderLine {
  readonly holder: HolderId
  readonly name: string
  // The names of its collapsed repeat blocks.
  readonly aliases: ReadonlyArray<string>
  // Its name the day before, when renamed since.
  readonly renamedFrom: string | undefined
  // Mixed when its securities accounts' origins differ.
  readonly origin: Above5SecuritiesAccount["origin"] | "mixed"
  // % of listed shares × 100: before is the day before's, now this day's;
  // absent where it isn't listed. An earlier holder's before is its last.
  readonly stake: { readonly before?: number; readonly now?: number }
  // Its combined shares, or its last listing's when off the list.
  readonly shares: number
  // Against the day before: a New holder's whole holding, the day's Off
  // list's whole last holding out; undefined without a move this day.
  readonly shareChange: number | undefined
  readonly percentageChange: number | undefined
  // Undefined on the stock's first parsed day.
  readonly move: Move | undefined
  // An earlier holder's: the day after its last listing.
  readonly offListSince: string | undefined
  // The broker codes of the securities accounts its move went through,
  // largest change first, "custodian" for those without one: on a move,
  // those whose shares changed (a New holder's all, an Off-list holder's all
  // the day before's); none without a move this day.
  readonly through: ReadonlyArray<BrokerCode | "custodian">
  // On a Transfer, the brokers its shares left and reached; else none.
  readonly transfer: Transfer<BrokerCode | "custodian"> | undefined
  // The last TREND_PERIODS trading days up to the selected one, oldest
  // first.
  readonly trend: ReadonlyArray<TrendCell>
  // Largest first, then those emptied since the day before.
  readonly accounts: ReadonlyArray<SecuritiesAccountLine>
}

// A Transfer's sides, each custodian (or its broker) once, most shares
// first, and the shares that moved between them.
export interface Transfer<Side> {
  readonly from: ReadonlyArray<Side>
  readonly to: ReadonlyArray<Side>
  readonly shares: number
}

export interface HoldersDay {
  readonly dataDate: WibDate
  // The trading day the moves are against; undefined on the stock's first
  // parsed day.
  readonly against: string | undefined
  // The days the picker offers: every parsed day from the stock's first
  // with a holder, oldest first.
  readonly days: ReadonlyArray<WibDate>
  // Listed this day, most % first.
  readonly listed: ReadonlyArray<DailyHolderLine>
  // Listed the day before and not now, most % first.
  readonly offList: ReadonlyArray<DailyHolderLine>
  // Every earlier holder not listed now nor the day before: the latest
  // off the list first, then most % first.
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
        readonly transfer: number
        readonly offList: number
      }
    | undefined
}

// The custodians whose shares a holder's securities accounts changed, each
// by its broker's accounts' summed change (a bank's by its own name), so
// shares moved within one broker cancel out, however IDX spells it; each
// broker named by its first custodian. Undefined when none changed.
//
// Decision: a Transfer is shares crossing brokers with the total unchanged
// (apps/dashboard/docs/adr/0135-a-transfer-is-shares-crossing-brokers-with-the-total-unchanged.md)
const transferOf = Effect.fnUntraced(function* (
  changes: ReadonlyArray<readonly [custodian: string, change: number]>
): Effect.fn.Return<Transfer<string> | undefined> {
  const net = new Map<string, { custodian: string; change: number }>()
  for (const [custodian, change] of changes) {
    const key = (yield* brokerOf(custodian)) ?? custodian
    const held = net.get(key)
    if (held === undefined) net.set(key, { custodian, change })
    else held.change += change
  }
  const moved = [...net.values()].filter(({ change }) => change !== 0)
  if (moved.length === 0) return undefined
  const side = (sign: number) =>
    moved
      .filter(({ change }) => Math.sign(change) === sign)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .map(({ custodian }) => custodian)
  return {
    from: side(-1),
    to: side(1),
    shares: moved.reduce((sum, { change }) => sum + Math.max(change, 0), 0),
  }
})

// A Transfer line's custodians, from its securities accounts' changes:
// what Holder moves stores of it (server/holdings/above-5-moves.ts).
export const transferredCustodians = (
  accounts: ReadonlyArray<SecuritiesAccountLine>
) =>
  transferOf(
    accounts.map(({ custodian, shareChange }) => [custodian, shareChange ?? 0])
  )

// A Transfer's custodians as their brokers, Custodian for those without.
//
// Decision: broker codes are looked up on read
// (apps/dashboard/docs/adr/0132-broker-codes-are-looked-up-on-read.md)
export const transferThrough = Effect.fnUntraced(function* (
  transfer: Transfer<string>
) {
  return {
    from: yield* throughOf(transfer.from),
    to: yield* throughOf(transfer.to),
    shares: transfer.shares,
  } satisfies Transfer<BrokerCode | "custodian">
})

// Decision: a holder matches by key, then as renamed, then as returning
// (apps/dashboard/docs/adr/0129-a-renamed-or-returning-holder-keeps-its-identity.md)
const BY_SHARES: MoveRule<DailyHolder> = {
  change: (before, now) => Effect.succeed(now.scripless - before.scripless),
  shares: (holder) => Effect.succeed(holder.scripless),
  renamed: (gone, arrived) =>
    Effect.sync(() => {
      if (gone.scripless === arrived.scripless) return true
      return arrived.accounts.some((account) =>
        gone.accounts.some(
          (each) =>
            each.custodian === account.custodian && each.name === account.name
        )
      )
    }),
  // Shares left one custodian for another: moved between accounts at one
  // custodian, they are no Transfer.
  transferred: (before, now) =>
    Effect.map(
      transferOf([
        ...before.accounts.map(
          ({ custodian, scripless }) => [custodian, -scripless] as const
        ),
        ...now.accounts.map(
          ({ custodian, scripless }) => [custodian, scripless] as const
        ),
      ]),
      (transfer) => transfer !== undefined
    ),
}

// A block repeats an earlier one of its stock-day when its securities
// accounts' custodians, names and shares, and its combined shares, are the
// same.
//
// Decision: repeat blocks are stored as published and collapsed on read
// (apps/dashboard/docs/adr/0131-above-5-repeat-blocks-are-stored-as-published.md)
const repeatSignature = ({ scripless, accounts }: Above5Holder) =>
  Effect.sync(() =>
    JSON.stringify([
      scripless,
      accounts
        .map((account) => [account.custodian, account.name, account.scripless])
        .sort((a, b) => {
          const [x, y] = [a.join(), b.join()]
          return x < y ? -1 : x > y ? 1 : 0
        }),
    ])
  )

// A stock-day's blocks, each repeat folded into the block it repeats.
export const dayHolders = (holders: ReadonlyArray<Above5Holder>) =>
  Effect.map(collapseRepeats(holders, repeatSignature), (collapsed) =>
    collapsed.map(({ holder, aliases }): DailyHolder => ({
      ...holder,
      aliases,
    }))
  )

// Each of `now`'s securities accounts paired with one of `before`'s by
// custodian and account name, equal shares first, then in order; the rest
// of `before` unpaired.
const pairAccounts = (
  now: ReadonlyArray<Above5SecuritiesAccount>,
  before: ReadonlyArray<Above5SecuritiesAccount>
) =>
  Effect.sync(() => {
    const left = new Set(before)
    const paired = now.map((): Above5SecuritiesAccount | undefined => undefined)
    const pass = (sameShares: boolean) =>
      now.forEach((account, at) => {
        if (paired[at] !== undefined) return
        const match = [...left].find(
          (each) =>
            each.custodian === account.custodian &&
            each.name === account.name &&
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
  now: ReadonlyArray<Above5SecuritiesAccount>,
  before: ReadonlyArray<Above5SecuritiesAccount> | undefined
) {
  const line = (
    account: Above5SecuritiesAccount,
    change: number | undefined
  ): Effect.Effect<SecuritiesAccountLine> =>
    Effect.map(brokerOf(account.custodian), (broker) => ({
      broker,
      custodian: account.custodian,
      name: account.name,
      origin: account.origin,
      domicile: account.domicile,
      shares: account.scripless,
      shareChange: change,
    }))
  const largestFirst = (lines: ReadonlyArray<SecuritiesAccountLine>) =>
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

// The custodians of the securities accounts a move went through, largest
// change first, each once at its largest: what Holder moves stores of a
// line's Through (server/holdings/above-5-moves.ts). A securities account
// with nothing to pair against (a New holder's, an Off-list holder's last)
// moved its whole holding.
export const movedCustodians = (
  accounts: ReadonlyArray<SecuritiesAccountLine>
) =>
  Effect.sync(() => {
    const moved = accounts
      .map((account) => ({
        account,
        change: Math.abs(account.shareChange ?? account.shares),
      }))
      .filter(({ change }) => change !== 0)
      .sort((a, b) => b.change - a.change)
    return [...new Set(moved.map(({ account }) => account.custodian))]
  })

// The broker of each of `custodians`, "custodian" for one without, each
// once at its first.
//
// Decision: broker codes are looked up on read
// (apps/dashboard/docs/adr/0132-broker-codes-are-looked-up-on-read.md)
export const throughOf = Effect.fnUntraced(function* (
  custodians: ReadonlyArray<string>
) {
  const brokers = yield* Effect.forEach(custodians, brokerOf)
  return [
    ...new Set(brokers.map((broker) => broker ?? "custodian")),
  ] satisfies DailyHolderLine["through"]
})

const transferLine = Effect.fnUntraced(function* (
  move: Move | undefined,
  accounts: ReadonlyArray<SecuritiesAccountLine>
) {
  if (move !== "transfer") return undefined
  const transfer = yield* transferredCustodians(accounts)
  return transfer && (yield* transferThrough(transfer))
})

const originOf = (accounts: ReadonlyArray<Above5SecuritiesAccount>) =>
  Effect.sync((): DailyHolderLine["origin"] => {
    const origins = new Set(accounts.map(({ origin }) => origin))
    return origins.size > 1
      ? "mixed"
      : origins.has("foreign")
        ? "foreign"
        : "local"
  })

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
      // A New holder's whole holding came in.
      shareChange:
        move === "new"
          ? now.scripless
          : before && now.scripless - before.scripless,
      percentageChange:
        before && now.percentageHundredths - before.percentageHundredths,
      move,
      offListSince: undefined,
      through:
        move === undefined
          ? []
          : yield* throughOf(yield* movedCustodians(accounts)),
      transfer: yield* transferLine(move, accounts),
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
      // The day's Off list took its whole last holding out; an earlier
      // holder didn't move this day.
      shareChange: offListSince === undefined ? -last.scripless : undefined,
      percentageChange: undefined,
      move: "off list",
      offListSince,
      // Only the day's Off list moved this day; an earlier holder left before.
      through:
        offListSince === undefined
          ? yield* throughOf(yield* movedCustodians(accounts))
          : [],
      transfer: undefined,
      trend: yield* trend(holder),
      accounts,
    } satisfies DailyHolderLine
  })

  const listed = yield* mostFirst(
    yield* Effect.forEach(selectedMoves.listed, listedLine),
    ({ stake }) => stake.now
  )
  const offList = yield* mostFirst(
    yield* Effect.forEach(selectedMoves.offList, (each) =>
      unlistedLine(each, undefined)
    ),
    ({ stake }) => stake.before
  )
  const history = (yield* Effect.forEach(
    yield* earlierHolders(moves, index),
    (each) => unlistedLine(each, each.since)
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
          transfer: counted("transfer"),
          offList: offList.length,
        }
      : undefined,
  } satisfies HoldersDay
})
