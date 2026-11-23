// Stockbit's socket credentials and its channel message (spec
// apinrdw/kumora#138, "Broker connections"). After the socket opens, the tab
// fetches a websocket key with its own bearer token, and the relay sends one
// WebsocketRequest naming every channel it wants.
import { INDEX_CODES, type StockCode } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import type { Answer, LocalRequest } from "./broker.ts"
import { jwtPayloadText } from "./jwt.ts"

// The key comes from Stockbit's REST host, called from the tab with
// the token in its credential cookies. The relay never refreshes the token:
// it reads the cookies again before every key fetch, so it uses whatever the
// page last refreshed. See apinrdw/kumora#43.
export const WEBSOCKET_KEY_URL =
  "https://exodus.stockbit.com/auth/websocket/key"

// The access token is in one of two cookies, likely by how the
// owner signed in. `credentialStorage` held it before; after a Google
// sign-in (seen 2026-11-20) it holds the user's profile and no token, and
// the token is in `sb_social_access_token`, with the same `data.uid`.
// `credentialStorage` is read first. See apinrdw/kumora#591.
const CREDENTIAL_COOKIES = ["credentialStorage", "sb_social_access_token"]

// Both REST calls stay on `exodus.stockbit.com` with the token as a
// Bearer header. The page itself now calls `exodus.api.stockbit.com` with its
// cookies and no `Authorization` header (seen 2026-11-20). Whether that host
// takes the Bearer header is untested, so moving there is a separate question
// from which cookie holds the token. See apinrdw/kumora#591.
//
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

// The Stockbit tab's sign-in, as its credential cookies hold it.
interface TabSignIn {
  // Every credential cookie's raw value. A change in any is a new sign-in or
  // a refreshed token.
  readonly cookies: string
  // The first credential cookie's token; none when no cookie holds one.
  readonly credential: Option.Option<StockbitCredential>
}

interface CookieTab {
  readonly request: (
    request: LocalRequest
  ) => Effect.Effect<Option.Option<Answer>>
}

// Decision: the worker reads the Stockbit tab's cookies with chrome.cookies
// (apps/extension/docs/adr/0021-the-worker-reads-stockbit-s-cookies-with-chrome-cookies.md)
//
// A cookie is looked up for the site, then for its API host: a
// Google sign-in's `sb_social_access_token` is sent to
// `exodus.api.stockbit.com` and isn't visible by the site's URL (seen
// 2026-11-20: `getAll` under `https://stockbit.com/*` found none). The
// manifest's `https://*.stockbit.com/*` host permission covers both.
const STOCKBIT_COOKIE_URLS = [
  "https://stockbit.com/",
  "https://exodus.api.stockbit.com/",
] as const

// A Stockbit cookie's value in Chrome's cookie store, "" when it is missing.
const chromeCookie = (name: string) =>
  Effect.gen(function* () {
    for (const url of STOCKBIT_COOKIE_URLS) {
      const cookie = yield* Effect.tryPromise(() =>
        chrome.cookies.get({ url, name })
      )
      if (cookie?.value !== undefined) return cookie.value
    }
    return ""
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Stockbit cookie read failed", error)
    ),
    Effect.orElseSucceed(() => "")
  )

// The Stockbit tab, its cookie requests answered from Chrome's cookie store.
export const withChromeCookies = <
  Tab extends CookieTab & { readonly attached: Effect.Effect<boolean> },
>(
  tab: Tab,
  read: (name: string) => Effect.Effect<string> = chromeCookie
) => ({
  ...tab,
  request: (request: LocalRequest) =>
    request._tag === "cookie"
      ? Effect.flatMap(tab.attached, (attached) =>
          attached
            ? Effect.map(read(request.name), (body) =>
                Option.some<Answer>({
                  _tag: "answer",
                  id: 0,
                  status: 200,
                  body,
                })
              )
            : Effect.succeedNone
        )
      : tab.request(request),
})

// The tab's sign-in, read from its cookies at call time; none when the tab
// doesn't answer.
export const tabSignIn = Effect.fnUntraced(function* (tab: CookieTab) {
  const values: Array<string> = []
  let credential = Option.none<StockbitCredential>()
  for (const name of CREDENTIAL_COOKIES) {
    const cookie = yield* tab.request({ _tag: "cookie", name })
    if (Option.isNone(cookie)) return Option.none<TabSignIn>()
    values.push(cookie.value.body)
    if (Option.isNone(credential))
      credential = yield* stockbitCredential(cookie.value.body)
  }
  return Option.some<TabSignIn>({ cookies: values.join("\n"), credential })
})

// The tab's current credential; none when it is signed out or doesn't answer.
export const tabCredential = (tab: CookieTab) =>
  Effect.map(
    tabSignIn(tab),
    Option.flatMap((signIn) => signIn.credential)
  )

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

// One channel message carries every listed code, unchunked. A new
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
