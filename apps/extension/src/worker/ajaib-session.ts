// Who the relay is on Ajaib (owner's decision, 2026-11-09, extending spec
// apinrdw/kumora#138 "Broker connections"): the account id its SUBSCRIBE
// frames carry, from the Ajaib tab's own access token, or, until the tab has
// shown one, from a PIN sign-in the owner starts on the options page.
import { Effect, Option, Schema, Semaphore } from "effect"

import { AjaibAccountId } from "./ajaib.ts"
import type { Answer } from "./broker.ts"
import { jwtPayloadText } from "./jwt.ts"
import type { PacedTab } from "./pacer.ts"
import type { BrokerTab } from "./tab.ts"

// Ajaib's PIN check, which the web app calls to get its tokens. Called from
// the Ajaib tab, so the page's cookies and headers apply.
export const PIN_VALIDATE_URL =
  "https://ht2.ajaib.co.id/api/v5/users/me/pin/validate"

// Decision: the account id is the access token's `sub` claim, as the archived
// orca-trader Ajaib capture read it; `user_id` and `id` are taken when `sub`
// is missing. No capture in this repo shows the claim, so the owner confirms
// it in DevTools (runbook, "The relay extension").
const Claims = Schema.fromJsonString(
  Schema.Struct({
    sub: Schema.optionalKey(Schema.Unknown),
    user_id: Schema.optionalKey(Schema.Unknown),
    id: Schema.optionalKey(Schema.Unknown),
  })
)
const decodeClaims = Schema.decodeUnknownOption(Claims)
const decodeId = Schema.decodeUnknownOption(AjaibAccountId)

// The account a token names; none when it names no numeric account.
export const ajaibAccountId = Effect.fnUntraced(function* (token: string) {
  const claims = Option.flatMap(yield* jwtPayloadText(token), decodeClaims)
  if (Option.isNone(claims)) return Option.none<AjaibAccountId>()
  const { sub, user_id, id } = claims.value
  return Option.firstSomeOf([sub, user_id, id].map((claim) => decodeId(claim)))
})

// Where a PIN sign-in stands, for the options page: none entered, a PIN
// waiting for an Ajaib tab, a call in flight, signed in with the answer's
// access token, or refused.
export const SignIn = Schema.Union([
  Schema.Struct({
    state: Schema.Literals([
      "none",
      "waiting",
      "signing-in",
      "wrong-pin",
      "needs-2fa",
      "failed",
    ]),
  }),
  Schema.Struct({
    state: Schema.Literal("signed-in"),
    accessToken: Schema.String,
  }),
])
export type SignIn = typeof SignIn.Type

const PinAnswer = Schema.fromJsonString(
  Schema.Struct({
    err_code: Schema.String,
    err_message: Schema.String,
    result: Schema.Struct({
      valid: Schema.Boolean,
      access_token: Schema.String,
      refresh_token: Schema.String,
      is_pin_6digit: Schema.Boolean,
      show_2fa: Schema.Boolean,
    }),
  })
)
const decodePinAnswer = Schema.decodeUnknownOption(PinAnswer)

const APPROVED = "EC0000000"

// The sign-in a validate answer gives. Approved means err_code EC0000000 and
// a valid PIN; a second factor asked for is no sign-in either.
export const pinOutcome = Effect.fnUntraced(function* (answer: Answer) {
  const decoded = decodePinAnswer(answer.body)
  if (answer.status !== 200 || Option.isNone(decoded))
    return { state: "failed" } satisfies SignIn as SignIn
  const { err_code, result } = decoded.value
  if (result.show_2fa) return { state: "needs-2fa" } as SignIn
  if (err_code !== APPROVED || !result.valid || result.access_token === "")
    return { state: "wrong-pin" } as SignIn
  return { state: "signed-in", accessToken: result.access_token } as SignIn
})

// One PIN the owner entered and its sign-in, as one read of
// chrome.storage.session (settings.ts) found them. A newer entry is kept
// apart, so a check or lock screen still busy with this one changes this one
// only.
export interface PinEntry {
  // The PIN, kept for the browser session so the lock screen
  // (ajaib-lock.ts) can type it, until it is wiped.
  readonly pin: Option.Option<string>
  readonly signIn: SignIn
  // The lock screen was handed the PIN, and has not been seen to go since.
  readonly typing: boolean
  // Wipes the PIN, and with it the `typing` mark.
  readonly wipePin: Effect.Effect<void>
  readonly setSignIn: (signIn: SignIn) => Effect.Effect<void>
  readonly setTyping: (typing: boolean) => Effect.Effect<void>
}

export interface PinStore {
  // The owner's newest entry, read whole; none before the first.
  readonly latest: Effect.Effect<Option.Option<PinEntry>>
}

export const makeAjaibSession = Effect.fnUntraced(function* (options: {
  // The Ajaib pacer's tab, so the PIN check waits for the site's pace.
  readonly tab: PacedTab & Pick<BrokerTab, "attached">
  readonly store: PinStore
}) {
  const { tab, store } = options
  const checking = yield* Semaphore.make(1)

  // Decision: a PIN is tried once: its sign-in moves from `waiting` (a new
  // entry) to `signing-in` before the call, one check at a time, so no
  // retry, restart or second tick sends it again; a wrong PIN tried twice
  // could lock the account. It stays for the lock screen only once signed
  // in, else it is wiped. See apinrdw/kumora#244, "The PIN's storage".
  const check = Effect.gen(function* () {
    if (!(yield* tab.attached)) return
    const latest = yield* store.latest
    if (Option.isNone(latest)) return
    const entry = latest.value
    if (entry.signIn.state !== "waiting") return
    if (Option.isNone(entry.pin))
      return yield* entry.setSignIn({ state: "none" })
    yield* entry.setSignIn({ state: "signing-in" })
    const answer = yield* tab.request({
      _tag: "page-post",
      url: PIN_VALIDATE_URL,
      body: JSON.stringify({ pin_code: entry.pin.value }),
    })
    const outcome: SignIn = Option.isSome(answer)
      ? yield* pinOutcome(answer.value)
      : { state: "failed" }
    if (outcome.state !== "signed-in") yield* entry.wipePin
    yield* entry.setSignIn(outcome)
  })
  // A tick that finds a check in flight does nothing.
  const tick = Effect.asVoid(checking.withPermitsIfAvailable(1)(check))

  // The PIN sign-in's access token, for the tab's REST calls before the page
  // made one of its own.
  const fallbackToken = Effect.gen(function* () {
    const latest = yield* store.latest
    return Option.flatMap(latest, ({ signIn }) =>
      signIn.state === "signed-in"
        ? Option.some(signIn.accessToken)
        : Option.none<string>()
    )
  })

  // The account id: from the tab's own token, else the PIN sign-in's; none
  // before either.
  const accountId = Effect.gen(function* () {
    const own = yield* tab.request({ _tag: "page-token" })
    const tabToken = Option.filter(
      Option.map(own, (answered) => answered.body),
      (body) => Option.isSome(own) && own.value.status === 200 && body !== ""
    )
    const token = Option.isSome(tabToken) ? tabToken : yield* fallbackToken
    return Option.isSome(token)
      ? yield* ajaibAccountId(token.value)
      : Option.none<AjaibAccountId>()
  })

  return { tick, fallbackToken, accountId }
})
