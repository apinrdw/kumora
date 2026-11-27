// The Holder map's holders (spec apinrdw/kumora#733): a holder is one
// holder key's blocks of one stock, report and period, summed. The read
// takes rows per block or per identity: a day's blocks, the day before's
// blocks of a key of several, a month's rows, Holder moves' leavings, a
// custodian's earlier blocks. Each kind becomes holders through
// `holdersByKey` here and nowhere else, so no part of the map (the bands,
// moves, crossings, hops, Off lists, custodian links and books) sees one
// block of a key that has two. A key's stored move is one identity's line,
// taken only for a key of one block on both days (`holder-map-moves.ts`). A
// crossing Down out of 5% needs only its key's newest leaving, so its
// statement groups by the month's stored key and returns one row a key
// (`holder-map.ts`).
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
import { StockCode, type WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { HolderKey, type KseiType, type SplitOrigin } from "@/domain/holdings"
import { dayHolders } from "@/lib/daily-holders"
import { placeOf } from "@/lib/holder-map-ids"

import { holderKey } from "./holder-key.ts"
import type { Account } from "./holder-map-custodians.ts"
import type { HolderMapLink } from "./holder-map-schema.ts"
import {
  above5Days,
  Above1HoldingRow,
  Above5HolderRow,
  Above5SecuritiesAccountRow,
} from "./stock-page.ts"

type Band = HolderMapLink["band"]

// The rows a holder is summed from, each with its stock.
export const Above5MapRow = Schema.Struct({
  ...Above5HolderRow.fields,
  stock_code: StockCode,
})
export const Above5AccountMapRow = Schema.Struct({
  ...Above5SecuritiesAccountRow.fields,
  stock_code: StockCode,
})
export const Above1MapRow = Schema.Struct({
  ...Above1HoldingRow.fields,
  stock_code: StockCode,
  issuer_name: Schema.String,
})

// Where a block sums: its stock, its report's band, its period and its
// holder key.
export interface KeyPeriod {
  readonly code: StockCode
  readonly band: Band
  readonly period: string
  readonly key: HolderKey
}

// A holder: its blocks at one KeyPeriod, how many, and their sum.
export interface KeyHolder<S> extends KeyPeriod {
  readonly blocks: number
  readonly sum: S
}

// A KeyPeriod as one string.
const keyPeriodId = (at: KeyPeriod) =>
  Effect.map(
    placeOf(at.code, at.key),
    (place) => `${at.band} ${at.period} ${place}`
  )

// The step: `blocks`, no two of them one listing, summed by KeyPeriod,
// each holder in the order of its first block. `add` may grow the sum
// `of` made for a holder's first block.
const holdersByKey = Effect.fnUntraced(function* <B, S>(
  blocks: Iterable<B>,
  at: (block: B) => Effect.Effect<KeyPeriod>,
  of: (block: B) => S,
  add: (sum: S, block: B) => S
) {
  const holders = new Map<string, { at: KeyPeriod; blocks: number; sum: S }>()
  for (const block of blocks) {
    const where = yield* at(block)
    const id = yield* keyPeriodId(where)
    const known = holders.get(id)
    if (known === undefined)
      holders.set(id, { at: where, blocks: 1, sum: of(block) })
    else {
      known.blocks += 1
      known.sum = add(known.sum, block)
    }
  }
  return [...holders.values()].map(
    ({ at: where, blocks: count, sum }): KeyHolder<S> => ({
      ...where,
      blocks: count,
      sum,
    })
  )
})

// An above-5% holder of a day: its first block's name, and its blocks' %,
// shares and securities accounts.
export interface Listed {
  readonly name: string
  hundredths: number
  shares: number
  readonly origins: Array<SplitOrigin>
  readonly accounts: Array<Account>
}

// A stock-day's above-5% holders: its blocks, each repeat folded into the
// block it repeats as Daily holders folds it (ADR 0131), then summed by
// key. `holders` and `accounts` are the stock's rows of `day` and any
// other, in report order.
export const listedHolders = Effect.fnUntraced(function* (
  code: StockCode,
  day: WibDate,
  holders: ReadonlyArray<typeof Above5MapRow.Type>,
  accounts: ReadonlyArray<typeof Above5AccountMapRow.Type>
) {
  const [blocks] = yield* above5Days(
    [{ data_date: day, listed_shares: null }],
    holders,
    accounts
  )
  return yield* holdersByKey(
    yield* dayHolders(blocks?.holders ?? []),
    (block) =>
      Effect.succeed({
        code,
        band: "5%" as const,
        period: day,
        key: HolderKey.make(block.key),
      }),
    (block): Listed => ({
      name: block.name,
      hundredths: block.percentageHundredths,
      shares: block.scripless,
      origins: block.accounts.map(({ origin }) => origin),
      accounts: [...block.accounts],
    }),
    (sum, block) => {
      sum.hundredths += block.percentageHundredths
      sum.shares += block.scripless
      sum.origins.push(...block.accounts.map(({ origin }) => origin))
      sum.accounts.push(...block.accounts)
      return sum
    }
  )
})

// A ≥1% holder of a month: its first row's name, its rows' %, total
// shares and origins, and the first KSEI type a row publishes.
interface MonthHolder {
  readonly name: string
  hundredths: number
  shares: number
  readonly origins: Array<SplitOrigin | undefined>
  type: KseiType | undefined
}

// A stock-month's ≥1% holders: its rows summed by key.
export const monthHolders = (
  code: StockCode,
  month: string,
  rows: ReadonlyArray<typeof Above1MapRow.Type>
) =>
  holdersByKey(
    rows,
    (row) =>
      Effect.succeed({
        code,
        band: "1%" as const,
        period: month,
        key: HolderKey.make(row.holder_key),
      }),
    (row): MonthHolder => ({
      name: row.investor_name,
      hundredths: row.percentage_hundredths,
      shares: row.total,
      origins: [row.origin ?? undefined],
      type: row.investor_type ?? undefined,
    }),
    (sum, row) => {
      sum.hundredths += row.percentage_hundredths
      sum.shares += row.total
      sum.origins.push(row.origin ?? undefined)
      sum.type ??= row.investor_type ?? undefined
      return sum
    }
  )

// A leaving's KeyPeriod, by its name's key, as the map matches Holder
// moves' lines to holders.
const leavingAt = Effect.fnUntraced(function* (line: {
  readonly stock_code: StockCode
  readonly band: Band
  readonly name: string
  readonly data_date: string
}) {
  return {
    code: line.stock_code,
    band: line.band,
    period: line.data_date,
    key: HolderKey.make(yield* holderKey(line.name)),
  } satisfies KeyPeriod
})

// A leaving as the map reads it: one identity's Off list line, its
// period the one it left.
export interface Leaving {
  readonly stock_code: StockCode
  readonly band: Band
  readonly name: string
  readonly data_date: string
  readonly stake_before: number
}

// The leavings of one holder in one period: its first line's name and
// their summed last stake.
interface Left {
  readonly name: string
  stakeBefore: number
}

// Leavings summed by key and the period left: blocks of one key leaving
// together leave as one holder, at their summed last stake.
export const leftHolders = (leavings: Iterable<Leaving>) =>
  holdersByKey(
    leavings,
    leavingAt,
    (left): Left => ({ name: left.name, stakeBefore: left.stake_before }),
    (sum, left) => {
      sum.stakeBefore += left.stake_before
      return sum
    }
  )
