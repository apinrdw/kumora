// Ajaib's on-demand subscriptions and its stock code list (spec
// apinrdw/kumora#138, "Broker connections" and "Stock code list").
import { StockCode } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import type { Payload } from "./broker.ts"

export type OnDemandStream = "PRICE" | "INDICATIVE" | "ORDER_BOOK_CUSTOM"

const message = (
  method: "SUBSCRIBE" | "UNSUBSCRIBE",
  stream: OnDemandStream,
  code: StockCode
): Payload => ({
  text: JSON.stringify({ method, stream, streamObject: code }),
})

// Decision: each code is subscribed once per socket. Ajaib answers a repeated
// subscribe with `invalid subscription object`, so a change sends only the
// difference: UNSUBSCRIBE for codes no longer wanted, SUBSCRIBE for new ones.
// A reopened socket starts from nothing. See apinrdw/kumora#50.
export const onDemandMessages = Effect.fnUntraced(function* (
  stream: OnDemandStream,
  from: ReadonlyArray<StockCode>,
  to: ReadonlyArray<StockCode>
) {
  const held = new Set(from)
  const wanted = new Set(to)
  return [
    ...from
      .filter((code) => !wanted.has(code))
      .map((code) => message("UNSUBSCRIBE", stream, code)),
    ...to
      .filter((code) => !held.has(code))
      .map((code) => message("SUBSCRIBE", stream, code)),
  ]
})

// The path of the code list on Ajaib's REST API, called with the page's own
// headers.
export const CODE_LIST_PATH = "v1/stock/data/list/"

const CodeListAnswer = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Array(Schema.Struct({ code: StockCode })),
  })
)
const decodeCodeList = Schema.decodeUnknownOption(CodeListAnswer)

// Every code on the list (3,406 on 2026-11-06, warrants included); none when
// the answer isn't a list.
export const listedCodes = Effect.fnUntraced(function* (body: string) {
  return Option.match(decodeCodeList(body), {
    onNone: () => [],
    onSome: (answer) => answer.data.map((entry) => entry.code),
  })
})
