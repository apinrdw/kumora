// What the options page sets and what the service worker reports back, both
// kept in chrome.storage (spec apinrdw/kumora#138, "Batching and targets").
import { WibDate, type Feed } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { AjaibLock } from "./ajaib-lock.ts"
import { SignIn, type PinStore } from "./ajaib-session.ts"
import {
  AjaibWalkPosition,
  type AjaibWalkStore,
} from "./broker-codes/ajaib-walk.ts"
import {
  HistoryPosition,
  type HistoryCatchUpStore,
  type HistoryStore,
} from "./broker-codes/history.ts"
import {
  BrokerCodesProgress,
  type IncompleteDaysStore,
} from "./broker-codes/run-queue.ts"
import { CodeListCache, RelayOutcome, type CodeListStore } from "./code-list.ts"

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

// The code list, so a worker that restarts holds today's list at once and
// fetches it only once a day, with the CodeList envelope it sent, for a target
// that connects later in the day (code-list.ts).
const CODE_LIST_KEY = "codeList"

export const codeListStore: CodeListStore = {
  load: Effect.gen(function* () {
    const stored = yield* Effect.promise(() =>
      chrome.storage.local.get(CODE_LIST_KEY)
    )
    return Schema.decodeUnknownOption(CodeListCache)(stored[CODE_LIST_KEY])
  }),
  save: Effect.fnUntraced(function* (list: CodeListCache) {
    const encoded = yield* Effect.orDie(
      Schema.encodeEffect(CodeListCache)(list)
    )
    yield* Effect.promise(() =>
      chrome.storage.local.set({ [CODE_LIST_KEY]: encoded })
    )
  }),
}

// The held list as the options page shows it: its day and how many codes.
export const loadHeldCodeList = Effect.map(codeListStore.load, (held) =>
  Option.map(held, ({ date, codes }) => ({ date, count: codes.length }))
)

export const isHeldCodeListChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "local" && CODE_LIST_KEY in changes
})

// Decision: the options page's relay button asks the worker through session
// storage, as the settings do: it writes `asked`, a change wakes a stopped
// worker, and the worker writes the outcome back under the same key.
const CODE_LIST_RELAY_KEY = "codeListRelay"

const CodeListRelay = Schema.Struct({
  state: Schema.Union([Schema.Literal("asked"), RelayOutcome]),
  at: Schema.Number,
})
export type CodeListRelay = typeof CodeListRelay.Type
const decodeRelay = Schema.decodeUnknownOption(CodeListRelay)

export const saveCodeListRelay = Effect.fnUntraced(function* (
  relay: CodeListRelay
) {
  yield* Effect.promise(() =>
    chrome.storage.session.set({ [CODE_LIST_RELAY_KEY]: relay })
  )
})

export const loadCodeListRelay = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.session.get(CODE_LIST_RELAY_KEY)
  )
  return decodeRelay(stored[CODE_LIST_RELAY_KEY])
})

export const isCodeListRelayChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "session" && CODE_LIST_RELAY_KEY in changes
})

// A change that asks the worker to relay: the new value is `asked`.
export const isCodeListRelayAsk = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, chrome.storage.StorageChange>>,
  area: string
) {
  if (!(yield* isCodeListRelayChange(changes, area))) return false
  const asked = decodeRelay(changes[CODE_LIST_RELAY_KEY]?.newValue)
  return Option.isSome(asked) && asked.value.state === "asked"
})

// Decision: a test-only clock offset, in ms, moves the relay's schedule
// (streaming hours, auctions, the code list's day) so the extension e2e runs
// in streaming hours at any time; frames keep their real receive times. Only
// a script in the worker's console sets it, never the options page.
// See apinrdw/kumora#155.
//
// apps/e2e/support/relay-extension.ts names this key too: it sets the offset.
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

// Decision: a changed offset ticks the relay at once, so a spec that moves the
// clock waits for that tick instead of the next 10 s one. With the key never
// set, as in the owner's browser, the relay ticks only on its timer. See
// apinrdw/kumora#174.
export const isClockOffsetChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "local" && CLOCK_OFFSET_KEY in changes
})

// Decision: the Ajaib PIN lives in chrome.storage.session alone: in memory,
// cleared when Chrome closes, out of content scripts' reach. It is never
// logged and leaves the extension only for the Ajaib tab's PIN check. The
// sign-in and its token sit beside it, so a restarted worker keeps them. See
// https://developer.chrome.com/docs/extensions/reference/api/storage.
const PIN_KEY = "ajaibPin"
const SIGN_IN_KEY = "ajaibSignIn"

export const AjaibPin = Schema.String.check(Schema.isPattern(/^\d{6}$/)).pipe(
  Schema.brand("AjaibPin")
)
export type AjaibPin = typeof AjaibPin.Type

// A new entry: tried once, on the next tick with an Ajaib tab, then kept for
// the lock screen until Chrome closes or Ajaib refuses it (ajaib-session.ts).
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
  pin: Effect.gen(function* () {
    const stored = yield* Effect.promise(() =>
      chrome.storage.session.get(PIN_KEY)
    )
    return decodePin(stored[PIN_KEY])
  }),
  wipePin: Effect.promise(() => chrome.storage.session.remove(PIN_KEY)),
  signIn: loadSignIn,
  setSignIn: (signIn) =>
    Effect.promise(() => chrome.storage.session.set({ [SIGN_IN_KEY]: signIn })),
}

// The relayed Ajaib tab's PIN lock (ajaib-lock.ts), in session storage: it
// describes this browser session's tab only. A `locked` state is the cause
// "Ajaib locked" the options page and badge show.
const AJAIB_LOCK_KEY = "ajaibLock"

export const saveAjaibLock = Effect.fnUntraced(function* (lock: AjaibLock) {
  const encoded = yield* Effect.orDie(Schema.encodeEffect(AjaibLock)(lock))
  yield* Effect.promise(() =>
    chrome.storage.session.set({ [AJAIB_LOCK_KEY]: encoded })
  )
})

// Ajaib's walk position for the day it walks (ajaib-walk.ts), in local
// storage so a restarted worker or browser carries on: Ajaib can't be asked
// where a walk stopped. Production's walk and the extra target's catch-up
// (extra-target.ts) each keep their own.
const ajaibWalkStoreAt = (key: string) =>
  Effect.sync((): AjaibWalkStore => ({
    load: Effect.gen(function* () {
      const stored = yield* Effect.promise(() => chrome.storage.local.get(key))
      return Schema.decodeUnknownOption(AjaibWalkPosition)(stored[key])
    }),
    save: Effect.fnUntraced(function* (position: AjaibWalkPosition) {
      const encoded = yield* Effect.orDie(
        Schema.encodeEffect(AjaibWalkPosition)(position)
      )
      yield* Effect.promise(() => chrome.storage.local.set({ [key]: encoded }))
    }),
  }))

export const ajaibWalkStore = ajaibWalkStoreAt("brokerCodesAjaibWalk")
export const ajaibCatchUpStore = ajaibWalkStoreAt("brokerCodesAjaibCatchUp")

// The days whose broker codes may still be incomplete (run-queue.ts), in
// local storage so a restarted worker or browser still walks their gaps. A
// value that doesn't decode reads as none.
const INCOMPLETE_DAYS_KEY = "brokerCodesIncompleteDays"
const IncompleteDays = Schema.Array(WibDate)
const decodeIncompleteDays = Schema.decodeUnknownOption(IncompleteDays)

export const incompleteDaysStore: IncompleteDaysStore = {
  load: Effect.gen(function* () {
    const stored = yield* Effect.promise(() =>
      chrome.storage.local.get(INCOMPLETE_DAYS_KEY)
    )
    return Option.getOrElse(
      decodeIncompleteDays(stored[INCOMPLETE_DAYS_KEY]),
      (): ReadonlyArray<WibDate> => []
    )
  }),
  save: (days) =>
    Effect.promise(() =>
      chrome.storage.local.set({ [INCOMPLETE_DAYS_KEY]: days })
    ),
}

// The History walk's positions (history.ts), in local storage so a
// restarted worker or browser carries on: Production's, and the extra
// target's, kept with the origin it caught up, so another extra target
// starts its own. A value that doesn't decode reads as none, which the walk
// rebuilds.
const HISTORY_KEY = "brokerCodesHistory"
const HISTORY_CATCH_UP_KEY = "brokerCodesHistoryCatchUp"
const HistoryCatchUp = Schema.Struct({
  origin: DashboardOrigin,
  oldest: WibDate,
})

export const historyStore: HistoryStore = {
  load: Effect.gen(function* () {
    const stored = yield* Effect.promise(() =>
      chrome.storage.local.get(HISTORY_KEY)
    )
    return Schema.decodeUnknownOption(HistoryPosition)(stored[HISTORY_KEY])
  }),
  save: Effect.fnUntraced(function* (position: HistoryPosition) {
    const encoded = yield* Effect.orDie(
      Schema.encodeEffect(HistoryPosition)(position)
    )
    yield* Effect.promise(() =>
      chrome.storage.local.set({ [HISTORY_KEY]: encoded })
    )
  }),
}

export const historyCatchUpStore = (
  // The extra target's origin as its settings stand now.
  origin: Effect.Effect<Option.Option<DashboardOrigin>>
): HistoryCatchUpStore => ({
  load: Effect.gen(function* () {
    const current = yield* origin
    if (Option.isNone(current)) return Option.none<WibDate>()
    const stored = yield* Effect.promise(() =>
      chrome.storage.local.get(HISTORY_CATCH_UP_KEY)
    )
    return Option.map(
      Option.filter(
        Schema.decodeUnknownOption(HistoryCatchUp)(
          stored[HISTORY_CATCH_UP_KEY]
        ),
        (kept) => kept.origin === current.value
      ),
      ({ oldest }) => oldest
    )
  }),
  save: Effect.fnUntraced(function* (oldest: WibDate) {
    const current = yield* origin
    if (Option.isNone(current)) return
    const encoded = yield* Effect.orDie(
      Schema.encodeEffect(HistoryCatchUp)({ origin: current.value, oldest })
    )
    yield* Effect.promise(() =>
      chrome.storage.local.set({ [HISTORY_CATCH_UP_KEY]: encoded })
    )
  }),
})

// What the broker codes run queue is doing (run-queue.ts), for the options
// page, in session storage: it describes this browser session's walks.
const BROKER_CODES_PROGRESS_KEY = "brokerCodesProgress"

export const saveBrokerCodesProgress = Effect.fnUntraced(function* (
  progress: BrokerCodesProgress
) {
  const encoded = yield* Effect.orDie(
    Schema.encodeEffect(BrokerCodesProgress)(progress)
  )
  yield* Effect.promise(() =>
    chrome.storage.session.set({ [BROKER_CODES_PROGRESS_KEY]: encoded })
  )
})

export const loadBrokerCodesProgress = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.session.get(BROKER_CODES_PROGRESS_KEY)
  )
  return Schema.decodeUnknownOption(BrokerCodesProgress)(
    stored[BROKER_CODES_PROGRESS_KEY]
  )
})

export const isBrokerCodesProgressChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "session" && BROKER_CODES_PROGRESS_KEY in changes
})

// Decision: the owner's Pause switch lives in chrome.storage.local, so a
// pause holds across restarts of the worker and of Chrome. It stops every
// broker codes walk; the live relay and Market Live's backfill go on. See
// apinrdw/kumora#244, "Pause".
const BROKER_CODES_PAUSED_KEY = "brokerCodesPaused"

export const loadBrokerCodesPaused = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.local.get(BROKER_CODES_PAUSED_KEY)
  )
  return stored[BROKER_CODES_PAUSED_KEY] === true
})

export const saveBrokerCodesPaused = Effect.fnUntraced(function* (
  paused: boolean
) {
  yield* Effect.promise(() =>
    chrome.storage.local.set({ [BROKER_CODES_PAUSED_KEY]: paused })
  )
})

// A change of the switch: some(true) when it was turned on.
export const brokerCodesPausedChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, chrome.storage.StorageChange>>,
  area: string
) {
  if (area !== "local" || !(BROKER_CODES_PAUSED_KEY in changes))
    return Option.none<boolean>()
  return Option.some(changes[BROKER_CODES_PAUSED_KEY]?.newValue === true)
})

// Decision: "Run now" asks the worker through session storage, as the code
// list's relay button does: the page writes `asked`, the change wakes a
// stopped worker, and the worker answers `started` once it has triggered
// the run queue, so the next press is a change again. See
// apinrdw/kumora#244, "Run now".
const BROKER_CODES_RUN_KEY = "brokerCodesRun"
const BrokerCodesRun = Schema.Literals(["asked", "started"])
type BrokerCodesRun = typeof BrokerCodesRun.Type

export const saveBrokerCodesRun = Effect.fnUntraced(function* (
  run: BrokerCodesRun
) {
  yield* Effect.promise(() =>
    chrome.storage.session.set({ [BROKER_CODES_RUN_KEY]: run })
  )
})

export const loadBrokerCodesRun = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.session.get(BROKER_CODES_RUN_KEY)
  )
  return Schema.decodeUnknownOption(BrokerCodesRun)(
    stored[BROKER_CODES_RUN_KEY]
  )
})

export const isBrokerCodesRunChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "session" && BROKER_CODES_RUN_KEY in changes
})

export const isBrokerCodesRunAsk = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, chrome.storage.StorageChange>>,
  area: string
) {
  return (
    (yield* isBrokerCodesRunChange(changes, area)) &&
    changes[BROKER_CODES_RUN_KEY]?.newValue === "asked"
  )
})

// Until when (epoch ms) each site's pacer stopped calling after a throttle
// (pacer.ts), in session storage for the options page.
const THROTTLED_KEY = "brokerCodesThrottled"
const Throttled = Schema.Struct({
  Stockbit: Schema.optionalKey(Schema.Finite),
  Ajaib: Schema.optionalKey(Schema.Finite),
})
type Throttled = typeof Throttled.Type

export const loadThrottled = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.session.get(THROTTLED_KEY)
  )
  return Option.getOrElse(
    Schema.decodeUnknownOption(Throttled)(stored[THROTTLED_KEY]),
    (): Throttled => ({})
  )
})

export const saveThrottled = Effect.fnUntraced(function* (
  feed: Feed,
  until: number
) {
  const throttled = yield* loadThrottled
  yield* Effect.promise(() =>
    chrome.storage.session.set({
      [THROTTLED_KEY]: { ...throttled, [feed]: until },
    })
  )
})

export const isThrottledChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "session" && THROTTLED_KEY in changes
})

export const loadAjaibLock = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.session.get(AJAIB_LOCK_KEY)
  )
  return Schema.decodeUnknownOption(AjaibLock)(stored[AJAIB_LOCK_KEY])
})

export const isAjaibLockChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "session" && AJAIB_LOCK_KEY in changes
})

export const isHistoryChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "local" && HISTORY_KEY in changes
})
