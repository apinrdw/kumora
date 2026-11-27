// What /holder-map reads from its URL (spec apinrdw/kumora#733, "Route"):
// the focus and the as-of trading day, each left out when absent, so a plain
// link opens the landing view on the newest day.
import { type BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import {
  CustodianId,
  HolderKey,
  type HolderMapQuery,
  type MoveKind,
} from "@/domain/holdings"

import { field } from "./holder-moves-search"

// At most one is set: the map has one focus.
export interface HolderMapSearch {
  // The focus stock; absent for the landing view.
  readonly stock?: StockCode | undefined
  // The focus holder, by its holder key.
  readonly holder?: HolderKey | undefined
  // The focus custodian, by its broker code or its name's key.
  readonly custodian?: CustodianId | undefined
  // The as-of trading day; absent for the newest parsed.
  readonly day?: WibDate | undefined
}

/**
 * Keeps the fields that parse and drops anything else; a stock code and a
 * custodian as typed in any case. A URL naming two foci names none: the
 * landing view. A
 * dropped one is set `undefined`: the router lays the validated search
 * over the raw one, which would keep it.
 */
export const parseHolderMapSearch = Effect.fnUntraced(function* (
  raw: Record<string, unknown>
): Effect.fn.Return<HolderMapSearch> {
  const stock = yield* field(
    StockCode,
    typeof raw.stock === "string" ? raw.stock.toUpperCase() : raw.stock
  )
  const holder = yield* field(HolderKey, raw.holder)
  const custodian = yield* field(
    CustodianId,
    typeof raw.custodian === "string"
      ? raw.custodian.toUpperCase()
      : raw.custodian
  )
  const named = [stock, holder, custodian].filter(
    (focus) => focus !== undefined
  ).length
  const one = named === 1
  return {
    stock: one ? stock : undefined,
    holder: one ? holder : undefined,
    custodian: one ? custodian : undefined,
    day: yield* field(WibDate, raw.day),
  }
})

// A refocus's search over the one before: the new focus, the others
// cleared, the day kept.
export const refocused = (
  previous: HolderMapSearch,
  focus:
    | { readonly stock: StockCode }
    | { readonly holder: HolderKey }
    | { readonly custodian: CustodianId }
) =>
  Effect.succeed<HolderMapSearch>({
    stock: undefined,
    holder: undefined,
    custodian: undefined,
    ...focus,
    day: previous.day,
  })

/**
 * Where a Holder moves row opens the map (spec apinrdw/kumora#733, "Links
 * in"): its stock, as of the row's day for a Daily row; a Monthly row's month
 * isn't a trading day, so it opens the newest.
 */
export const holderMapMoveSearch = (
  kind: MoveKind,
  stock: StockCode,
  period: WibDate
) =>
  Effect.succeed<HolderMapSearch>(
    kind === "daily" ? { stock, day: period } : { stock }
  )

// What the map's search offers (server/holdings/holder-map-search-list.ts,
// `holderMapSearchList`).
export interface FocusList {
  readonly stocks: ReadonlyArray<{
    readonly code: StockCode
    readonly issuerName: string
  }>
  readonly holders: ReadonlyArray<{
    readonly key: string
    readonly name: string
  }>
  readonly custodians: ReadonlyArray<{
    readonly id: string
    readonly broker: BrokerCode | undefined
    readonly name: string
  }>
}

// One match of the search.
export type FocusMatch =
  | {
      readonly kind: "stock"
      readonly code: StockCode
      readonly name: string
    }
  | {
      readonly kind: "holder"
      readonly key: HolderKey
      readonly name: string
    }
  | {
      readonly kind: "custodian"
      readonly id: CustodianId
      readonly broker: BrokerCode | undefined
      readonly name: string
    }

const words = (text: string) => text.toUpperCase().split(/\s+/).filter(Boolean)

/**
 * The search's first `shown` matches of `query`: stocks whose code starts
 * with it, then stocks whose code or issuer name holds every word typed,
 * then custodians whose broker code is the word typed or whose name holds
 * every word, then holders whose name does. An empty query lists the
 * stocks.
 */
export const findFoci = (list: FocusList, query: string, shown: number) =>
  Effect.sync((): ReadonlyArray<FocusMatch> => {
    const typed = words(query)
    const holds = (text: string) => {
      const upper = text.toUpperCase()
      return typed.every((word) => upper.includes(word))
    }
    const stock = ({ code, issuerName }: FocusList["stocks"][number]) => ({
      kind: "stock" as const,
      code,
      name: issuerName,
    })
    if (typed.length === 0) return list.stocks.slice(0, shown).map(stock)
    const [first = ""] = typed
    const byCode = list.stocks.filter(
      ({ code }) => typed.length === 1 && code.startsWith(first)
    )
    const byName = list.stocks.filter(
      (each) =>
        !byCode.includes(each) && holds(`${each.code} ${each.issuerName}`)
    )
    const matches: Array<FocusMatch> = [...byCode, ...byName].map(stock)
    for (const custodian of list.custodians)
      if (
        (typed.length === 1 && custodian.broker === first) ||
        holds(custodian.name)
      )
        matches.push({
          kind: "custodian",
          id: CustodianId.make(custodian.id),
          broker: custodian.broker,
          name: custodian.name,
        })
    for (const holder of list.holders) {
      if (matches.length >= shown) break
      if (holds(holder.name))
        matches.push({
          kind: "holder",
          key: HolderKey.make(holder.key),
          name: holder.name,
        })
    }
    return matches.slice(0, shown)
  })

export const queryOf = ({ stock, holder, custodian, day }: HolderMapSearch) =>
  Effect.succeed<HolderMapQuery>({
    focus:
      stock !== undefined
        ? { kind: "stock", code: stock }
        : holder !== undefined
          ? { kind: "holder", key: holder }
          : custodian !== undefined
            ? { kind: "custodian", id: custodian }
            : undefined,
    day,
  })
