import {
  decodeStockCodeList,
  stockCodeListPath,
  type ListedCode,
  type WibDate,
} from "@workspace/relay"
import { Effect, Option } from "effect"
import * as HttpClient from "effect/http/HttpClient"

import { SignInRequired } from "./market-live-socket.ts"

// The trading day's stock code list from the dashboard Worker. None when the
// relay hasn't sent that day's list yet (404) or the Worker can't answer; a
// 401 fails SignInRequired.
export const fetchStockCodeList = Effect.fnUntraced(function* (date: WibDate) {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get(yield* stockCodeListPath(date))
  if (response.status === 401) return yield* new SignInRequired()
  if (response.status !== 200) return Option.none<ReadonlyArray<ListedCode>>()
  const { codes } = yield* decodeStockCodeList(yield* response.text)
  return Option.some(codes)
})

const KIND_RANK: Record<ListedCode["kind"], number> = {
  share: 0,
  warrant: 1,
  right: 2,
}

// How well a code matches the query: the code itself, a code starting with
// it, then a name containing it. None for no match.
const matchRank = (listed: ListedCode, query: string) => {
  if (listed.code === query) return 0
  if (listed.code.startsWith(query)) return 1
  if (listed.name.toUpperCase().includes(query)) return 2
  return undefined
}

// The codes a search offers, best first: by match, then shares above warrants
// and rights, then shorter codes, then A to Z. An empty query offers the
// shares from A.
export const searchStockCodes = Effect.fnUntraced(function* (
  codes: ReadonlyArray<ListedCode>,
  query: string,
  limit: number
) {
  const wanted = query.trim().toUpperCase()
  return codes
    .flatMap((listed) => {
      const rank = matchRank(listed, wanted)
      return rank === undefined ? [] : [{ listed, rank }]
    })
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
