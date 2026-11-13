// Stockbit's socket credentials and its channel message (spec
// apinrdw/kumora#138, "Broker connections"). After the socket opens, the tab
// fetches a websocket key with its own bearer token, and the relay sends one
// WebsocketRequest naming every channel it wants.
import { INDEX_CODES, type StockCode } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import type { Answer, TabRequest } from "./broker.ts"
import { jwtPayloadText } from "./jwt.ts"

// Decision: the key comes from Stockbit's REST host, called from the tab with
// the token in its `credentialStorage` cookie. The relay never refreshes the
// token: it reads the cookie again before every key fetch, so it uses
// whatever the page last refreshed. See apinrdw/kumora#43.
export const WEBSOCKET_KEY_URL =
  "https://exodus.stockbit.com/auth/websocket/key"
export const CREDENTIAL_COOKIE = "credentialStorage"

// Stockbit's REST running-trade tape, which backfill pages by trade number.
export const RUNNING_TRADE_URL =
  "https://exodus.stockbit.com/order-trade/running-trade"

export interface StockbitCredential {
  readonly accessToken: string
  readonly userId: string
}

const JWT = /eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/

const JwtPayload = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({ uid: Schema.Union([Schema.String, Schema.Number]) }),
  })
)
const decodePayload = Schema.decodeUnknownOption(JwtPayload)

// The access token in the cookie's value, and the user it names. The cookie's
// layout is the page's business, so this takes the first JWT in it.
export const stockbitCredential = Effect.fnUntraced(function* (cookie: string) {
  const text = Option.getOrElse(
    Option.liftThrowable(decodeURIComponent)(cookie),
    () => cookie
  )
  const accessToken = JWT.exec(text)?.[0]
  if (accessToken === undefined) return Option.none<StockbitCredential>()
  return (yield* jwtPayloadText(accessToken)).pipe(
    Option.flatMap(decodePayload),
    Option.map((payload): StockbitCredential => ({
      accessToken,
      userId: String(payload.data.uid),
    }))
  )
})

// The tab's current credential, read from its cookie at call time.
export const tabCredential = Effect.fnUntraced(function* (tab: {
  readonly request: (
    request: TabRequest
  ) => Effect.Effect<Option.Option<Answer>>
}) {
  const cookie = yield* tab.request({ _tag: "cookie", name: CREDENTIAL_COOKIE })
  return Option.isSome(cookie)
    ? yield* stockbitCredential(cookie.value.body)
    : Option.none<StockbitCredential>()
})

const KeyAnswer = Schema.fromJsonString(
  Schema.Struct({ data: Schema.Struct({ key: Schema.String }) })
)
const decodeKeyAnswer = Schema.decodeUnknownOption(KeyAnswer)

export const websocketKey = Effect.fnUntraced(function* (body: string) {
  return Option.map(decodeKeyAnswer(body), (answer) => answer.data.key)
})

// Protobuf, by hand: strings and nested messages are all this frame needs.
const utf8 = new TextEncoder()

const varint = Effect.fnUntraced(function* (value: number) {
  const bytes: Array<number> = []
  let rest = value
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80)
    rest >>>= 7
  }
  bytes.push(rest)
  return bytes
})

const lengthDelimited = Effect.fnUntraced(function* (
  field: number,
  bytes: ArrayLike<number>
) {
  return [
    ...(yield* varint((field << 3) | 2)),
    ...(yield* varint(bytes.length)),
    ...Array.from(bytes),
  ]
})

const strings = Effect.fnUntraced(function* (
  field: number,
  values: ReadonlyArray<string>
) {
  const bytes: Array<number> = []
  for (const value of values)
    bytes.push(...(yield* lengthDelimited(field, utf8.encode(value))))
  return bytes
})

// securities.transactional.datafeed.v1 field numbers.
const Channel = {
  orderBook: 2,
  runningTradeBatch: 5,
  liveprice: 6,
  iepiev: 7,
} as const
const Request = { userId: 1, channel: 2, key: 3, accessToken: 5 } as const

// Decision: one channel message carries every listed code, unchunked. A new
// channel message replaces the whole subscription (apinrdw/kumora#48), so
// chunks sent on one socket would each cancel the one before. 690 codes in one
// message are proven; whether Stockbit caps a message below Ajaib's ~3,400
// codes is unmeasured. See apinrdw/kumora#155.
//
// `running_trade_batch` `["*"]` is the only wildcard Stockbit honours, so
// `liveprice`, `order_book` and `iepiev` list every code. The indices, which
// have no book and no auction, take `liveprice` alone, code list or not.
export const subscribeFrame = Effect.fnUntraced(function* (options: {
  readonly credential: StockbitCredential
  readonly key: string
  readonly codes: ReadonlyArray<StockCode>
}) {
  const { credential, key, codes } = options
  const channel = [
    ...(yield* strings(Channel.orderBook, codes)),
    ...(yield* strings(Channel.runningTradeBatch, ["*"])),
    ...(yield* strings(Channel.liveprice, [...codes, ...INDEX_CODES])),
    ...(yield* strings(Channel.iepiev, codes)),
  ]
  return Uint8Array.from([
    ...(yield* strings(Request.userId, [credential.userId])),
    ...(yield* lengthDelimited(Request.channel, channel)),
    ...(yield* strings(Request.key, [key])),
    ...(yield* strings(Request.accessToken, [credential.accessToken])),
  ])
})
