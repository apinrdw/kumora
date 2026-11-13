// What the options page sets and what the service worker reports back, both
// kept in chrome.storage (spec apinrdw/kumora#138, "Batching and targets").
import { Feed, WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import { AjaibLock } from "./ajaib-lock.ts"
import { SignIn, type PinEntry, type PinStore } from "./ajaib-session.ts"
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
// logged and leaves the worker only for the Ajaib tab's PIN check and lock
// screen (`type-pin`); a restarted worker finds its sign-in beside it. See
// https://developer.chrome.com/docs/extensions/reference/api/storage.
//
// Decision: each entry keeps its PIN and sign-in under keys named by its
// own id, and ENTRY_KEY names the newest. A check or lock screen still busy
// with an older entry writes that entry's keys only: chrome.storage has no
// compare-and-set to guard one shared key.
const ENTRY_KEY = "ajaibPinEntry"
const PIN_PREFIX = "ajaibPin."
const SIGN_IN_PREFIX = "ajaibSignIn."

export const AjaibPin = Schema.String.check(Schema.isPattern(/^\d{6}$/)).pipe(
  Schema.brand("AjaibPin")
)
export type AjaibPin = typeof AjaibPin.Type

const decodePin = Schema.decodeUnknownOption(AjaibPin)
const decodeSignIn = Schema.decodeUnknownOption(SignIn)
const decodeEntry = Schema.decodeUnknownOption(Schema.String)

// A new entry: tried once, on the next tick with an Ajaib tab, then kept for
// the lock screen until Chrome closes or Ajaib refuses it (ajaib-session.ts).
// Older entries go, all but the newest should two saves overlap.
export const savePin = Effect.fnUntraced(function* (pin: AjaibPin) {
  const entry = yield* Effect.sync(() => crypto.randomUUID())
  const waiting: SignIn = { state: "waiting" }
  yield* Effect.promise(() =>
    chrome.storage.session.set({
      [ENTRY_KEY]: entry,
      [`${PIN_PREFIX}${entry}`]: pin,
      [`${SIGN_IN_PREFIX}${entry}`]: waiting,
    })
  )
  const stored = yield* Effect.promise(() => chrome.storage.session.get(null))
  const newest = Option.getOrElse(decodeEntry(stored[ENTRY_KEY]), () => entry)
  const older = Object.keys(stored).filter(
    (key) =>
      (key.startsWith(PIN_PREFIX) || key.startsWith(SIGN_IN_PREFIX)) &&
      key !== `${PIN_PREFIX}${newest}` &&
      key !== `${SIGN_IN_PREFIX}${newest}`
  )
  if (older.length > 0)
    yield* Effect.promise(() => chrome.storage.session.remove(older))
})

const storedEntry = Effect.fnUntraced(function* (entry: string) {
  const pinKey = `${PIN_PREFIX}${entry}`
  const signInKey = `${SIGN_IN_PREFIX}${entry}`
  return {
    pin: Effect.gen(function* () {
      const stored = yield* Effect.promise(() =>
        chrome.storage.session.get(pinKey)
      )
      return decodePin(stored[pinKey])
    }),
    wipePin: Effect.promise(() => chrome.storage.session.remove(pinKey)),
    signIn: Effect.gen(function* () {
      const stored = yield* Effect.promise(() =>
        chrome.storage.session.get(signInKey)
      )
      return Option.getOrElse(decodeSignIn(stored[signInKey]), (): SignIn => ({
        state: "none",
      }))
    }),
    setSignIn: (signIn) =>
      Effect.promise(() => chrome.storage.session.set({ [signInKey]: signIn })),
  } satisfies PinEntry as PinEntry
})

export const sessionPinStore: PinStore = {
  latest: Effect.gen(function* () {
    const stored = yield* Effect.promise(() =>
      chrome.storage.session.get(ENTRY_KEY)
    )
    const entry = decodeEntry(stored[ENTRY_KEY])
    return Option.isSome(entry)
      ? Option.some(yield* storedEntry(entry.value))
      : Option.none<PinEntry>()
  }),
}

// The newest entry's sign-in, for the options page.
export const loadSignIn = Effect.gen(function* () {
  const latest = yield* sessionPinStore.latest
  return Option.isSome(latest)
    ? yield* latest.value.signIn
    : ({ state: "none" } satisfies SignIn as SignIn)
})

export const isSignInChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return (
    area === "session" &&
    Object.keys(changes).some(
      (key) => key === ENTRY_KEY || key.startsWith(SIGN_IN_PREFIX)
    )
  )
})

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

// A value the extra target's catch-up keeps in local storage beside the
// origin it was kept for. It reads as none for another origin, while no
// extra target is set, or when it doesn't decode; it is saved only while
// one is set.
const keptForOrigin = <A, I>(
  key: string,
  value: Schema.Codec<A, I>,
  // The extra target's origin as its settings stand now.
  origin: Effect.Effect<Option.Option<DashboardOrigin>>
) =>
  Effect.sync(() => {
    const Kept = Schema.Struct({ origin: DashboardOrigin, value })
    return {
      load: Effect.gen(function* () {
        const current = yield* origin
        if (Option.isNone(current)) return Option.none<A>()
        const stored = yield* Effect.promise(() =>
          chrome.storage.local.get(key)
        )
        return Option.map(
          Option.filter(
            Schema.decodeUnknownOption(Kept)(stored[key]),
            (kept) => kept.origin === current.value
          ),
          (kept) => kept.value
        )
      }),
      save: Effect.fnUntraced(function* (kept: A) {
        const current = yield* origin
        if (Option.isNone(current)) return
        const encoded = yield* Effect.orDie(
          Schema.encodeEffect(Kept)({ origin: current.value, value: kept })
        )
        yield* Effect.promise(() =>
          chrome.storage.local.set({ [key]: encoded })
        )
      }),
    }
  })

// Ajaib's walk position for the day it walks (ajaib-walk.ts), in local
// storage so a restarted worker or browser carries on: Ajaib can't be asked
// where a walk stopped. Production's walk and the extra target's catch-up
// (extra-target.ts) each keep their own, the catch-up's with the origin it
// caught up, so another extra target starts its own.
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
export const ajaibCatchUpStore = (
  origin: Effect.Effect<Option.Option<DashboardOrigin>>
) =>
  keptForOrigin(
    "brokerCodesAjaibCatchUp",
    AjaibWalkPosition,
    origin
  ) satisfies Effect.Effect<AjaibWalkStore>

// The days whose broker codes may still be incomplete (run-queue.ts), and
// the newest closed day the last run walked, in local storage so a
// restarted worker or browser still walks their gaps and the evenings it
// missed. A value that doesn't decode reads as none.
const INCOMPLETE_DAYS_KEY = "brokerCodesIncompleteDays"
const LAST_NEWEST_DAY_KEY = "brokerCodesLastNewestDay"
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
  lastNewest: Effect.gen(function* () {
    const stored = yield* Effect.promise(() =>
      chrome.storage.local.get(LAST_NEWEST_DAY_KEY)
    )
    return Schema.decodeUnknownOption(WibDate)(stored[LAST_NEWEST_DAY_KEY])
  }),
  saveLastNewest: (day) =>
    Effect.promise(() =>
      chrome.storage.local.set({ [LAST_NEWEST_DAY_KEY]: day })
    ),
}

// The History walk's positions (history.ts), in local storage so a
// restarted worker or browser carries on: Production's, and the extra
// target's, kept with the origin it caught up, so another extra target
// starts its own. A value that doesn't decode reads as none, which the walk
// rebuilds.
const HISTORY_KEY = "brokerCodesHistory"

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
  origin: Effect.Effect<Option.Option<DashboardOrigin>>
) =>
  keptForOrigin(
    "brokerCodesHistoryCatchUp",
    WibDate,
    origin
  ) satisfies Effect.Effect<HistoryCatchUpStore>

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
// (pacer.ts), in session storage for the options page and for the pacers a
// restarted service worker builds. Each site has its own key, so two pacers
// throttled at once never write over each other's.
const THROTTLED_PREFIX = "brokerCodesThrottled."
const decodeUntil = Schema.decodeUnknownOption(Schema.Finite)

export const loadThrottled = Effect.gen(function* () {
  const keys = Feed.literals.map((feed) => `${THROTTLED_PREFIX}${feed}`)
  const stored = yield* Effect.promise(() => chrome.storage.session.get(keys))
  const throttled: Partial<Record<Feed, number>> = {}
  for (const feed of Feed.literals) {
    const until = decodeUntil(stored[`${THROTTLED_PREFIX}${feed}`])
    if (Option.isSome(until)) throttled[feed] = until.value
  }
  return throttled
})

export const saveThrottled = Effect.fnUntraced(function* (
  feed: Feed,
  until: number
) {
  yield* Effect.promise(() =>
    chrome.storage.session.set({ [`${THROTTLED_PREFIX}${feed}`]: until })
  )
})

export const isThrottledChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return (
    area === "session" &&
    Object.keys(changes).some((key) => key.startsWith(THROTTLED_PREFIX))
  )
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
