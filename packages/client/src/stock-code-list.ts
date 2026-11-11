import {
  decodeStockCodeList,
  stockCodeListPath,
  type ListedCode,
  type WibDate,
} from "@workspace/relay"
import { Effect, Option } from "effect"

import { getRecorded } from "./recorded-day.ts"

// The trading day's stock code list from the dashboard Worker. None when the
// relay hasn't sent that day's list yet (404); a 401 fails SignInRequired,
// and a Worker that can't answer fails.
export const fetchStockCodeList = Effect.fnUntraced(function* (date: WibDate) {
  const body = yield* getRecorded(yield* stockCodeListPath(date))
  if (Option.isNone(body)) return Option.none<ReadonlyArray<ListedCode>>()
  const { codes } = yield* decodeStockCodeList(body.value)
  return Option.some(codes)
})

const KIND_RANK: Record<ListedCode["kind"], number> = {
  share: 0,
  index: 0,
  warrant: 1,
  right: 2,
}

// How well a code matches the query: the code itself, a code starting with
// it, then a name containing it. None for no match.
const matchRank = Effect.fnUntraced(function* (
  listed: ListedCode,
  query: string
) {
  if (listed.code === query) return 0
  if (listed.code.startsWith(query)) return 1
  if (listed.name.toUpperCase().includes(query)) return 2
  return undefined
})

// The codes a search offers, best first: by match, then shares and indices
// above warrants and rights, then shorter codes, then A to Z. An empty query offers the
// shares from A.
export const searchStockCodes = Effect.fnUntraced(function* (
  codes: ReadonlyArray<ListedCode>,
  query: string,
  limit: number
) {
  const wanted = query.trim().toUpperCase()
  const matches: Array<{ listed: ListedCode; rank: number }> = []
  for (const listed of codes) {
    const rank = yield* matchRank(listed, wanted)
    if (rank !== undefined) matches.push({ listed, rank })
  }
  return matches
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        KIND_RANK[a.listed.kind] - KIND_RANK[b.listed.kind] ||
        a.listed.code.length - b.listed.code.length ||
        (a.listed.code < b.listed.code ? -1 : 1)
    )
    .slice(0, limit)
    .map(({ listed }) => listed)
})
