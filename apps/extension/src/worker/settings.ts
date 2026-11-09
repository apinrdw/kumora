// What the options page sets and what the service worker reports back, both
// kept in chrome.storage (spec apinrdw/kumora#138, "Batching and targets").
import { EncodedIngestUp, StockCode, WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { SignIn, type PinStore } from "./ajaib-session.ts"

// Where a dashboard serves: an origin, `https://host` or `http://host:port`.
export const DashboardOrigin = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^/\s]+$/)
).pipe(Schema.brand("DashboardOrigin"))
export type DashboardOrigin = typeof DashboardOrigin.Type

// Production is always relayed; one extra target (Staging, a Preview or a Dev
// stage) is optional.
const TargetName = Schema.Literals(["production", "extra"])
export type TargetName = typeof TargetName.Type

// Decision: the ingest tokens live in chrome.storage.local, pasted once per
// target. Pairing from the dashboard was rejected. See apinrdw/kumora#134.
const Settings = Schema.Struct({
  productionToken: Schema.String,
  extra: Schema.NullOr(
    Schema.Struct({ origin: DashboardOrigin, token: Schema.String })
  ),
})
export type Settings = typeof Settings.Type

const noSettings: Settings = { productionToken: "", extra: null }

// A target's ingest socket. `off` has no token; `rejected-token` and
// `reload-extension` stopped on 4403 and 4426 until the settings change.
const TargetState = Schema.Literals([
  "off",
  "connecting",
  "connected",
  "retrying",
  "rejected-token",
  "reload-extension",
])
export type TargetState = typeof TargetState.Type

const TargetStates = Schema.Record(TargetName, TargetState)
export type TargetStates = typeof TargetStates.Type

const SETTINGS_KEY = "settings"
const STATES_KEY = "targetStates"

// Settings missing or unreadable read as none, so a fresh install starts off.
export const loadSettings = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.local.get(SETTINGS_KEY)
  )
  return Option.getOrElse(
    Schema.decodeUnknownOption(Settings)(stored[SETTINGS_KEY]),
    () => noSettings
  )
})

export const saveSettings = Effect.fnUntraced(function* (settings: Settings) {
  const encoded = yield* Schema.encodeEffect(Settings)(settings)
  yield* Effect.promise(() =>
    chrome.storage.local.set({ [SETTINGS_KEY]: encoded })
  )
})

export const isSettingsChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "local" && SETTINGS_KEY in changes
})

// The states live in session storage: they describe this browser session's
// sockets only.
export const saveTargetStates = Effect.fnUntraced(function* (
  states: TargetStates
) {
  yield* Effect.promise(() =>
    chrome.storage.session.set({ [STATES_KEY]: states })
  )
})

export const loadTargetStates = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.session.get(STATES_KEY)
  )
  return Schema.decodeUnknownOption(TargetStates)(stored[STATES_KEY])
})

export const isTargetStatesChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "session" && STATES_KEY in changes
})

// The day's stock code list, kept so a restarted worker subscribes Stockbit
// at once and fetches the list only once a day, with the CodeList envelope
// it sent, for a target that connects later in the day.
const CodeListCache = Schema.Struct({
  date: WibDate,
  codes: Schema.Array(StockCode),
  envelope: EncodedIngestUp,
})
export type CodeListCache = typeof CodeListCache.Type

const CODE_LIST_KEY = "codeList"

export const loadCodeList = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.local.get(CODE_LIST_KEY)
  )
  return Schema.decodeUnknownOption(CodeListCache)(stored[CODE_LIST_KEY])
})

export const saveCodeList = Effect.fnUntraced(function* (list: CodeListCache) {
  const encoded = yield* Schema.encodeEffect(CodeListCache)(list)
  yield* Effect.promise(() =>
    chrome.storage.local.set({ [CODE_LIST_KEY]: encoded })
  )
})

// Decision: a test-only clock offset, in ms, moves the relay's schedule (its
// streaming hours, its auctions and the code list's day) and nothing else, so
// the extension e2e can run in streaming hours at any time of day. Only a script
// in the service worker's console sets it; the options page never shows it.
// Frames keep their real receive times. See apinrdw/kumora#155.
const CLOCK_OFFSET_KEY = "clockOffsetMs"

export const loadClockOffset = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.local.get(CLOCK_OFFSET_KEY)
  )
  return Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Finite)(stored[CLOCK_OFFSET_KEY]),
    () => 0
  )
})

// Decision: the Ajaib PIN lives in chrome.storage.session alone: in memory,
// cleared when Chrome closes, out of content scripts' reach. It is never
// logged and never leaves the extension but for the one PIN check the Ajaib
// tab makes (ajaib-session.ts). The sign-in and its access token sit beside
// it, so a restarted worker keeps them until Chrome closes.
const PIN_KEY = "ajaibPin"
const SIGN_IN_KEY = "ajaibSignIn"

export const AjaibPin = Schema.String.check(Schema.isPattern(/^\d{6}$/)).pipe(
  Schema.brand("AjaibPin")
)
export type AjaibPin = typeof AjaibPin.Type

// A new entry: tried once, on the next tick with an Ajaib tab.
export const savePin = Effect.fnUntraced(function* (pin: AjaibPin) {
  const waiting: SignIn = { state: "waiting" }
  yield* Effect.promise(() =>
    chrome.storage.session.set({ [PIN_KEY]: pin, [SIGN_IN_KEY]: waiting })
  )
})

const decodePin = Schema.decodeUnknownOption(AjaibPin)
const decodeSignIn = Schema.decodeUnknownOption(SignIn)

export const loadSignIn = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.session.get(SIGN_IN_KEY)
  )
  return Option.getOrElse(decodeSignIn(stored[SIGN_IN_KEY]), (): SignIn => ({
    state: "none",
  }))
})

export const isSignInChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "session" && SIGN_IN_KEY in changes
})

export const sessionPinStore: PinStore = {
  takePin: Effect.gen(function* () {
    const stored = yield* Effect.promise(() =>
      chrome.storage.session.get(PIN_KEY)
    )
    yield* Effect.promise(() => chrome.storage.session.remove(PIN_KEY))
    return decodePin(stored[PIN_KEY])
  }),
  signIn: loadSignIn,
  setSignIn: (signIn) =>
    Effect.promise(() => chrome.storage.session.set({ [SIGN_IN_KEY]: signIn })),
}
