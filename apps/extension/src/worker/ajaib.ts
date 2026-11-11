// Ajaib's on-demand subscriptions and its stock code list (spec
// apinrdw/kumora#138, "Broker connections" and "Stock code list").
import { decodeAjaibCodeList, type StockCode } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import type { Payload } from "./broker.ts"

export type OnDemandStream = "PRICE" | "INDICATIVE" | "ORDER_BOOK_CUSTOM"

// The Ajaib account id a frame carries as `id`: a number, as a token claim
// carries it or as digits.
export const AjaibAccountId = Schema.Union([
  Schema.Int,
  Schema.NumberFromString.check(Schema.isInt()),
]).pipe(Schema.brand("AjaibAccountId"))
export type AjaibAccountId = typeof AjaibAccountId.Type

// Decision: a frame carries the account id once the relay knows it, in the
// page's own field order (`{"method","id","stream","streamObject"}`, seen
// 2026-11-06, apinrdw/kumora#50); until then it goes without, as the relay
// always sent it. The id comes from the tab's token or the PIN sign-in
// (ajaib-session.ts).
const message = Effect.fnUntraced(function* (
  method: "SUBSCRIBE" | "UNSUBSCRIBE",
  stream: "TRADE" | OnDemandStream,
  streamObject: string,
  id: Option.Option<AjaibAccountId>
) {
  const payload: Payload = {
    text: JSON.stringify({
      method,
      ...(Option.isSome(id) ? { id: id.value } : {}),
      stream,
      streamObject,
    }),
  }
  return payload
})

// The whole-market tape, subscribed once as the trade socket opens.
export const tradeSubscribe = (id: Option.Option<AjaibAccountId>) =>
  message("SUBSCRIBE", "TRADE", "*", id)

// Decision: each code is subscribed once per socket, and a change of the
// on-demand set sends only the difference: UNSUBSCRIBE for codes no longer
// wanted, SUBSCRIBE for new ones. That is "subscribe once per connection" per
// code: the spec's repeated subscribe is the same code twice, which this
// never sends. A code in `fresh` the socket already holds is sent the pair,
// UNSUBSCRIBE then SUBSCRIBE, so that Ajaib sends its whole book again.
// Documented (spec apinrdw/kumora#138, "The extension"): ORDER_BOOK_CUSTOM
// sends its own `is_initial` snapshot on subscribing, then per-level
// deltas. Inferred, not yet observed on the relay's socket: that it sends
// the snapshot again after the pair. The pair is what Ajaib's own page
// sends when its code changes (owner's DevTools, 2026-11-06,
// apinrdw/kumora#50), which is also why the diff is kept over reopening the
// sockets; `invalid subscription object` there answered the PING-WEB ping. A
// reopened socket starts from nothing.
export const onDemandMessages = Effect.fnUntraced(function* (
  stream: OnDemandStream,
  from: ReadonlyArray<StockCode>,
  to: ReadonlyArray<StockCode>,
  fresh: ReadonlyArray<StockCode>,
  id: Option.Option<AjaibAccountId>
) {
  const held = new Set(from)
  const wanted = new Set(to)
  const again = new Set(fresh)
  const messages: Array<Payload> = []
  for (const code of from)
    if (!wanted.has(code) || again.has(code))
      messages.push(yield* message("UNSUBSCRIBE", stream, code, id))
  for (const code of to)
    if (!held.has(code) || again.has(code))
      messages.push(yield* message("SUBSCRIBE", stream, code, id))
  return messages
})

// The path of the code list on Ajaib's REST API, called with the page's own
// headers.
export const CODE_LIST_PATH = "v1/stock/data/list/"

// Every code on the list (3,406 on 2026-11-06, warrants included); none when
// the answer isn't a list.
export const listedCodes = Effect.fnUntraced(
  function* (body: string) {
    return (yield* decodeAjaibCodeList(body)).map((entry) => entry.code)
  },
  Effect.catchTag("SchemaError", () =>
    Effect.succeed<ReadonlyArray<StockCode>>([])
  )
)
