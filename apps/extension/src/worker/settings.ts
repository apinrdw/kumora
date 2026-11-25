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
import { ErrorLogEntry, redact, type ErrorLogStore } from "./error-log.ts"

// Where a dashboard serves: an origin, `https://host` or `http://host:port`.
export const DashboardUrl = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^/\s]+$/)
).pipe(Schema.brand("DashboardUrl"))
export type DashboardUrl = typeof DashboardUrl.Type

// Production is always relayed; one extra target (Staging, a Preview or a Dev
// stage) is optional.
const TargetName = Schema.Literals(["production", "extra"])
export type TargetName = typeof TargetName.Type

// Decision: ingest tokens live in chrome.storage.local, pasted once per target
// (apps/extension/docs/adr/0014-ingest-tokens-are-pasted-once-per-target.md)
const Settings = Schema.Struct({
  productionToken: Schema.String,
  extra: Schema.NullOr(
    // Stored as `origin`, its name from when it held an origin only, so an
    // earlier relay's settings still load.
    Schema.Struct({ url: DashboardUrl, token: Schema.String }).pipe(
      Schema.encodeKeys({ url: "origin" })
    )
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

// Decision: a logged cause is redacted as text, from every credential read
// (apps/extension/docs/adr/0010-credentials-are-redacted-as-text-before-a-cause-is-stored.md)
const seenSecrets = new Set<string>()

const remember = Effect.fnUntraced(function* (secrets: ReadonlyArray<string>) {
  for (const secret of secrets) seenSecrets.add(secret)
})

const SETTINGS_KEY = "settings"
const STATES_KEY = "targetStates"

// Settings missing or unreadable read as none, so a fresh install starts off.
export const loadSettings = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.local.get(SETTINGS_KEY)
  )
  const settings = Option.getOrElse(
    Schema.decodeUnknownOption(Settings)(stored[SETTINGS_KEY]),
    () => noSettings
  )
  yield* remember([
    settings.productionToken,
    ...(settings.extra === null ? [] : [settings.extra.token]),
  ])
  return settings
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

// Decision: a page asks the worker through a session storage key it answers
// (apps/extension/docs/adr/0015-pages-ask-the-worker-through-a-session-storage-key.md)
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

// Decision: a test-only clock offset moves the relay's schedule for e2e
// (apps/extension/docs/adr/0006-a-test-only-clock-offset-moves-the-relay-s-schedule.md)
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

// Decision: a test-only clock offset moves the relay's schedule for e2e
// (apps/extension/docs/adr/0006-a-test-only-clock-offset-moves-the-relay-s-schedule.md)
export const isClockOffsetChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "local" && CLOCK_OFFSET_KEY in changes
})

// Decision: the Ajaib PIN lives in chrome.storage.session alone, never logged
// (apps/extension/docs/adr/0016-the-ajaib-pin-lives-in-chrome-storage-session-alone.md)
//
// Decision: each PIN entry keeps its values under keys named by its own id
// (apps/extension/docs/adr/0017-each-pin-entry-keys-its-values-by-its-own-id.md)
const ENTRY_KEY = "ajaibPinEntry"
const PIN_PREFIX = "ajaibPin."
const SIGN_IN_PREFIX = "ajaibSignIn."
const TYPING_PREFIX = "ajaibPinTyping."
const ENTRY_PREFIXES = [PIN_PREFIX, SIGN_IN_PREFIX, TYPING_PREFIX]

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
      ENTRY_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
      !ENTRY_PREFIXES.some((prefix) => key === `${prefix}${newest}`)
  )
  if (older.length > 0)
    yield* Effect.promise(() => chrome.storage.session.remove(older))
})

export const sessionPinStore: PinStore = {
  latest: Effect.gen(function* () {
    const stored = yield* Effect.promise(() => chrome.storage.session.get(null))
    const entry = decodeEntry(stored[ENTRY_KEY])
    if (Option.isNone(entry)) return Option.none<PinEntry>()
    const pinKey = `${PIN_PREFIX}${entry.value}`
    const signInKey = `${SIGN_IN_PREFIX}${entry.value}`
    const typingKey = `${TYPING_PREFIX}${entry.value}`
    const pin = decodePin(stored[pinKey])
    const signIn = Option.getOrElse(
      decodeSignIn(stored[signInKey]),
      (): SignIn => ({ state: "none" })
    )
    yield* remember([
      ...Option.toArray(pin),
      ...(signIn.state === "signed-in" ? [signIn.accessToken] : []),
    ])
    return Option.some<PinEntry>({
      pin,
      signIn,
      typing: stored[typingKey] === true,
      wipePin: Effect.promise(() =>
        chrome.storage.session.remove([pinKey, typingKey])
      ),
      setSignIn: Effect.fnUntraced(function* (next: SignIn) {
        if (next.state === "signed-in") yield* remember([next.accessToken])
        yield* Effect.promise(() =>
          chrome.storage.session.set({ [signInKey]: next })
        )
      }),
      setTyping: (typing) =>
        Effect.promise(() =>
          typing
            ? chrome.storage.session.set({ [typingKey]: true })
            : chrome.storage.session.remove(typingKey)
        ),
    })
  }),
}

// The newest entry's sign-in, for the options page.
export const loadSignIn = Effect.map(
  sessionPinStore.latest,
  Option.match({
    onNone: (): SignIn => ({ state: "none" }),
    onSome: ({ signIn }) => signIn,
  })
)

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
// dashboard URL it was kept for. A load captures the URL as it stands, and
// reads as none for another URL, while none is set, or when it doesn't
// decode. A save is kept for the URL its load captured, and dropped once
// `url` stands elsewhere (target-hold.ts).
const keptForUrl = <A, I>(
  key: string,
  value: Schema.Codec<A, I>,
  // The extra target's URL while its operation's settings hold.
  url: Effect.Effect<Option.Option<DashboardUrl>>
) =>
  Effect.sync(() => {
    // Stored as `origin`, as the settings' extra target is.
    const Kept = Schema.Struct({ url: DashboardUrl, value }).pipe(
      Schema.encodeKeys({ url: "origin" })
    )
    let loaded = Option.none<DashboardUrl>()
    return {
      load: Effect.gen(function* () {
        loaded = yield* url
        const current = loaded
        if (Option.isNone(current)) return Option.none<A>()
        const stored = yield* Effect.promise(() =>
          chrome.storage.local.get(key)
        )
        return Option.map(
          Option.filter(
            Schema.decodeUnknownOption(Kept)(stored[key]),
            (kept) => kept.url === current.value
          ),
          (kept) => kept.value
        )
      }),
      save: Effect.fnUntraced(function* (kept: A) {
        const current = yield* url
        if (Option.isNone(loaded) || !Option.contains(current, loaded.value))
          return
        const encoded = yield* Effect.orDie(
          Schema.encodeEffect(Kept)({ url: loaded.value, value: kept })
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
// (extra-target.ts) each keep their own, the catch-up's with the URL it
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
  url: Effect.Effect<Option.Option<DashboardUrl>>
) =>
  keptForUrl(
    "brokerCodesAjaibCatchUp",
    AjaibWalkPosition,
    url
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
// target's, kept with the URL it caught up, so another extra target
// starts its own. A value that doesn't decode reads as none, which the walk
// rebuilds.
// Decision: History positions moved to new keys, so every install rewalks
// (apps/extension/docs/adr/0018-history-positions-moved-to-new-keys.md)
const HISTORY_KEY = "brokerCodesHistoryTrades"

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
  url: Effect.Effect<Option.Option<DashboardUrl>>
) =>
  keptForUrl(
    "brokerCodesHistoryTradesCatchUp",
    WibDate,
    url
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

// Decision: the Pause switch lives in chrome.storage.local and stops every walk
// (apps/extension/docs/adr/0019-the-pause-switch-lives-in-chrome-storage-local.md)
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

// Decision: a page asks the worker through a session storage key it answers
// (apps/extension/docs/adr/0015-pages-ask-the-worker-through-a-session-storage-key.md)
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
// apps/e2e/tests/relay-extension.spec.ts names this key too: it sets a throttle.
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

// Decision: error lines and the Relay stopped cause live in storage.session
// (apps/extension/docs/adr/0020-error-lines-live-in-chrome-storage-session.md)
const ERROR_LOG_KEY = "relayErrors"
const RELAY_STOPPED_KEY = "relayStopped"
const ErrorLog = Schema.Array(ErrorLogEntry)

// The PINs, sign-in tokens and ingest tokens in storage now, and every one
// the worker read before.
const knownSecrets = Effect.gen(function* () {
  const session = yield* Effect.promise(() => chrome.storage.session.get(null))
  yield* remember(
    Object.entries(session).flatMap(([key, value]) => {
      if (key.startsWith(PIN_PREFIX)) return Option.toArray(decodePin(value))
      if (!key.startsWith(SIGN_IN_PREFIX)) return []
      const signIn = decodeSignIn(value)
      return Option.isSome(signIn) && signIn.value.state === "signed-in"
        ? [signIn.value.accessToken]
        : []
    })
  )
  yield* loadSettings
  return [...seenSecrets]
})

export const errorLogStore: ErrorLogStore = {
  secrets: knownSecrets,
  load: Effect.gen(function* () {
    const stored = yield* Effect.promise(() =>
      chrome.storage.session.get(ERROR_LOG_KEY)
    )
    return Option.getOrElse(
      Schema.decodeUnknownOption(ErrorLog)(stored[ERROR_LOG_KEY]),
      (): ReadonlyArray<ErrorLogEntry> => []
    )
  }),
  save: Effect.fnUntraced(function* (entries) {
    const encoded = yield* Effect.orDie(Schema.encodeEffect(ErrorLog)(entries))
    yield* Effect.promise(() =>
      chrome.storage.session.set({ [ERROR_LOG_KEY]: encoded })
    )
  }),
}

export const isErrorLogChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "session" && ERROR_LOG_KEY in changes
})

// When the worker's main loop ended, and its cause, pretty-printed.
const RelayStopped = Schema.Struct({ at: Schema.Finite, cause: Schema.String })
export type RelayStopped = typeof RelayStopped.Type

export const saveRelayStopped = Effect.fnUntraced(function* (
  stopped: RelayStopped
) {
  const cause = yield* redact(stopped.cause, yield* knownSecrets)
  yield* Effect.promise(() =>
    chrome.storage.session.set({ [RELAY_STOPPED_KEY]: { ...stopped, cause } })
  )
})

// A worker that starts again runs the relay again.
export const clearRelayStopped = Effect.promise(() =>
  chrome.storage.session.remove(RELAY_STOPPED_KEY)
)

export const loadRelayStopped = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.session.get(RELAY_STOPPED_KEY)
  )
  return Schema.decodeUnknownOption(RelayStopped)(stored[RELAY_STOPPED_KEY])
})

export const isRelayStoppedChange = Effect.fnUntraced(function* (
  changes: Readonly<Record<string, unknown>>,
  area: string
) {
  return area === "session" && RELAY_STOPPED_KEY in changes
})

// Diagnostics read these session keys by name, never
// `chrome.storage.session.get(null)`: the session area also holds the Ajaib
// PIN and its sign-in's tokens. See apinrdw/kumora#274.
const DIAGNOSTIC_KEYS = [
  BROKER_CODES_PROGRESS_KEY,
  BROKER_CODES_RUN_KEY,
  ...Feed.literals.map((feed) => `${THROTTLED_PREFIX}${feed}`),
  AJAIB_LOCK_KEY,
]

// The broker codes keys as stored, a missing one as null, in key order.
export const loadDiagnosticKeys = Effect.gen(function* () {
  const stored = yield* Effect.promise(() =>
    chrome.storage.session.get(DIAGNOSTIC_KEYS)
  )
  return DIAGNOSTIC_KEYS.map((key) => [key, stored[key] ?? null] as const)
})
