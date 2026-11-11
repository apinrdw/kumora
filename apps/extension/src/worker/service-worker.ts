// The relay's service worker (spec apinrdw/kumora#138, "The extension"). It
// drives the broker tabs' connections on a 10 s tick, batches their frames,
// and sends the envelopes to every target's ingest socket.
import {
  encodeIngestUp,
  wibDateAt,
  type EncodedIngestUp,
  type IngestDown,
  type IngestUp,
  type WibDate,
} from "@workspace/relay"
import {
  DateTime,
  Duration,
  Effect,
  FiberMap,
  Option,
  PubSub,
  Queue,
  Schedule,
  SubscriptionRef,
  type Scope,
} from "effect"
import * as Socket from "effect/socket/Socket"

import { makeAjaibSession } from "./ajaib-session.ts"
import { makeBackfill } from "./backfill.ts"
import { BATCH_INTERVAL, makeBatcher } from "./batch.ts"
import { ajaib, ajaibOnDemand, stockbit } from "./broker.ts"
import { makeCodeList } from "./code-list.ts"
import { windowAt } from "./gate.ts"
import { makeOnDemandCodes } from "./on-demand-codes.ts"
import {
  DashboardOrigin,
  codeListStore,
  isClockOffsetChange,
  isCodeListRelayAsk,
  isSettingsChange,
  loadClockOffset,
  loadSettings,
  saveCodeListRelay,
  saveTargetStates,
  sessionPinStore,
  type Settings,
  type TargetName,
  type TargetState,
  type TargetStates,
} from "./settings.ts"
import {
  makeAjaibSubscriptions,
  makeStockbitSubscriptions,
  type OnDemandSubscriptions,
  type Subscriptions,
} from "./subscriptions.ts"
import { makeBrokerTab, type BrokerTab } from "./tab.ts"
import { runTarget } from "./target.ts"

// Decision: the service worker ticks every 10 s; in-tab timers are throttled
// in background tabs and never relied on. A `chrome.alarms` alarm (Chrome's
// shortest period, 30 s since Chrome 120, per
// https://developer.chrome.com/docs/extensions/reference/api/alarms) wakes a
// worker Chrome stopped, and ticks only when the in-worker timer is overdue.
// See apinrdw/kumora#59.
const TICK = Duration.seconds(10)
const ALARM = "tick"

// Where a completed tick leaves its clock offset on the worker's global scope.
// apps/e2e/support/relay-extension.ts names it too: it reads it.
const LAST_TICK_KEY = "lastTickClockOffsetMs"

type WorkerEvent =
  | { readonly _tag: "connect"; readonly port: chrome.runtime.Port }
  | {
      readonly _tag: "message"
      readonly port: chrome.runtime.Port
      readonly message: unknown
    }
  | { readonly _tag: "disconnect"; readonly port: chrome.runtime.Port }
  | { readonly _tag: "tick" }
  | { readonly _tag: "alarm" }
  | { readonly _tag: "settings" }
  | { readonly _tag: "relay-code-list" }

// Chrome delivers the events that wake a stopped worker only to listeners
// added synchronously while its script first runs, so they are added here and
// queue what they get.
const events = Effect.runSync(Queue.unbounded<WorkerEvent>())
const queue = (event: WorkerEvent) => {
  Queue.offerUnsafe(events, event)
}
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((message) =>
    queue({ _tag: "message", port, message })
  )
  port.onDisconnect.addListener(() => queue({ _tag: "disconnect", port }))
  queue({ _tag: "connect", port })
})
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) queue({ _tag: "alarm" })
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (Effect.runSync(isSettingsChange(changes, area)))
    queue({ _tag: "settings" })
  if (Effect.runSync(isCodeListRelayAsk(changes, area)))
    queue({ _tag: "relay-code-list" })
  if (Effect.runSync(isClockOffsetChange(changes, area)))
    queue({ _tag: "tick" })
})

// The toolbar badge shows the worst target state.
const badges: Record<TargetState, { text: string; title: string }> = {
  off: { text: "", title: "no ingest token" },
  connected: { text: "", title: "relaying" },
  connecting: { text: "…", title: "connecting" },
  retrying: { text: "…", title: "unreachable, retrying" },
  "rejected-token": { text: "KEY", title: "ingest token rejected" },
  "reload-extension": { text: "RLD", title: "reload extension" },
}
const severity: ReadonlyArray<TargetState> = [
  "reload-extension",
  "rejected-token",
  "retrying",
  "connecting",
  "connected",
  "off",
]

const showStates = Effect.fnUntraced(function* (states: TargetStates) {
  yield* saveTargetStates(states)
  const worst =
    severity.find((state) => Object.values(states).includes(state)) ?? "off"
  const title = Object.entries(states)
    .map(([name, state]) => `${name}: ${badges[state].title}`)
    .join("\n")
  yield* Effect.promise(() =>
    chrome.action.setBadgeText({ text: badges[worst].text })
  )
  yield* Effect.promise(() =>
    chrome.action.setTitle({ title: `Kumora relay\n${title}` })
  )
})

// Targets: one fiber each, restarted when its settings change.
const makeTargets = Effect.fnUntraced(function* (options: {
  readonly envelopes: PubSub.PubSub<EncodedIngestUp>
  readonly day: SubscriptionRef.SubscriptionRef<WibDate>
  readonly catchUp: (
    day: WibDate
  ) => Effect.Effect<ReadonlyArray<EncodedIngestUp>>
  readonly receive: (
    name: TargetName,
    message: IngestDown | undefined
  ) => Effect.Effect<void>
}) {
  const { receive } = options
  const fibers = yield* FiberMap.make<TargetName>()
  const states: Record<TargetName, TargetState> = {
    production: "off",
    extra: "off",
  }
  // A target that isn't connected wants no on-demand codes.
  const report = (name: TargetName) => (state: TargetState) =>
    Effect.suspend(() => {
      states[name] = state
      return Effect.andThen(
        showStates({ ...states }),
        state === "connected" ? Effect.void : receive(name, undefined)
      )
    })
  const restart = Effect.fnUntraced(function* (
    name: TargetName,
    target: Settings["extra"]
  ) {
    yield* FiberMap.remove(fibers, name)
    if (target === null || target.token === "")
      return yield* report(name)("off")
    yield* FiberMap.run(
      fibers,
      name,
      runTarget({
        ...target,
        envelopes: options.envelopes,
        day: options.day,
        catchUp: options.catchUp,
        report: report(name),
        receive: (message) => receive(name, message),
      })
    )
  })

  let applied: Settings = { productionToken: "", extra: null }
  const apply = Effect.gen(function* () {
    const settings = yield* loadSettings
    if (settings.productionToken !== applied.productionToken)
      yield* restart("production", {
        origin: DashboardOrigin.make(__PRODUCTION_DASHBOARD__),
        token: settings.productionToken,
      })
    if (JSON.stringify(settings.extra) !== JSON.stringify(applied.extra))
      yield* restart("extra", settings.extra)
    applied = settings
  })
  yield* showStates({ ...states })
  yield* apply
  return { apply }
})

// Now on the relay's schedule clock.
const scheduleNow = Effect.gen(function* () {
  const now = yield* DateTime.now
  return DateTime.add(now, { milliseconds: yield* loadClockOffset })
})

const main = Effect.gen(function* () {
  const envelopes = yield* PubSub.sliding<EncodedIngestUp>(1024)
  const publish = (message: IngestUp) =>
    Effect.flatMap(Effect.orDie(encodeIngestUp(message)), (text) =>
      PubSub.publish(envelopes, text)
    )
  const batcher = yield* makeBatcher()
  yield* Effect.forkScoped(
    Effect.repeat(
      Effect.flatMap(batcher.flush, Effect.forEach(publish)),
      Schedule.spaced(BATCH_INTERVAL)
    )
  )

  // A changed list or on-demand set resubscribes the open sockets.
  const codeList = yield* makeCodeList({
    store: codeListStore,
    envelopes,
    changed: Effect.suspend(() => stockbitCodes.resubscribe(stockbitTab)),
  })
  const stockbitCodes: Subscriptions = yield* makeStockbitSubscriptions(
    codeList.codes
  )
  const onDemandCodes = yield* makeOnDemandCodes({
    changed: (fresh) =>
      Effect.suspend(() => onDemand.resubscribe(ajaibTab, fresh)),
    backfill: (name, message) =>
      Effect.suspend(() => backfill.request(name, message)),
  })
  const onDemand: OnDemandSubscriptions = yield* makeAjaibSubscriptions(
    onDemandCodes.codes,
    Effect.suspend(() => ajaibSession.accountId)
  )
  const stockbitTab = yield* makeBrokerTab({
    feed: "Stockbit",
    sites: [stockbit],
    batcher,
    publish,
    hooks: stockbitCodes.hooks,
  })
  const ajaibTab = yield* makeBrokerTab({
    feed: "Ajaib",
    sites: [ajaib, ...ajaibOnDemand],
    batcher,
    publish,
    hooks: onDemand.hooks,
  })
  const tabs = [stockbitTab, ajaibTab]
  const ajaibSession = yield* makeAjaibSession({
    tab: ajaibTab,
    store: sessionPinStore,
  })
  // The Ajaib tab's REST calls, with the PIN sign-in's token for the page's
  // API before the page made a call of its own.
  const ajaibRest: BrokerTab = {
    ...ajaibTab,
    request: (request) =>
      request._tag === "page-fetch"
        ? Effect.flatMap(ajaibSession.fallbackToken, (token) =>
            ajaibTab.request(
              Option.isSome(token)
                ? { ...request, token: token.value }
                : request
            )
          )
        : ajaibTab.request(request),
  }
  const backfill = yield* makeBackfill({
    stockbit: stockbitTab,
    ajaib: ajaibRest,
    publish,
  })
  yield* Effect.forkScoped(backfill.run)
  // Today's WIB date on the schedule clock, moved on by the tick.
  const day = yield* SubscriptionRef.make(yield* wibDateAt(yield* scheduleNow))
  const targets = yield* makeTargets({
    envelopes,
    day,
    catchUp: codeList.catchUp,
    receive: onDemandCodes.receive,
  })

  // The tick, from the worker's own timer and the alarm.
  let lastTick = 0
  const tick = Effect.fnUntraced(function* (alarm: boolean) {
    const now = yield* DateTime.now
    const ms = DateTime.toEpochMillis(now)
    if (alarm && ms - lastTick < Duration.toMillis(TICK)) return
    lastTick = ms
    const offset = yield* loadClockOffset
    const schedule = DateTime.add(now, { milliseconds: offset })
    const today = yield* wibDateAt(schedule)
    if (today !== (yield* SubscriptionRef.get(day)))
      yield* SubscriptionRef.set(day, today)
    const window = yield* windowAt(schedule)
    for (const tab of tabs) yield* tab.tick(window)
    // The PIN check's answer queues behind this tick.
    yield* Effect.forkScoped(ajaibSession.tick)
    yield* codeList.tick(ajaibRest, schedule)
    // Decision: a completed tick leaves the clock offset it ran on in the
    // worker's global scope, test-only like the offset itself, so a spec that
    // moved the clock reads it to await a tick on the new clock instead of
    // sleeping. See apinrdw/kumora#174.
    Object.assign(globalThis, { [LAST_TICK_KEY]: offset })
  })
  yield* Effect.forkScoped(
    Effect.repeat(
      Effect.sync(() => queue({ _tag: "tick" })),
      Schedule.spaced(TICK)
    )
  )
  yield* Effect.promise(() =>
    chrome.alarms.create(ALARM, { periodInMinutes: 0.5 })
  )

  const handle = (
    event: WorkerEvent
  ): Effect.Effect<
    unknown,
    never,
    Scope.Scope | Socket.WebSocketConstructor
  > => {
    switch (event._tag) {
      case "connect":
        return Effect.forEach(tabs, (tab) => tab.connect(event.port))
      case "message":
        return Effect.forEach(tabs, (tab) =>
          tab.message(event.port, event.message)
        )
      case "disconnect":
        return Effect.forEach(tabs, (tab) => tab.disconnect(event.port))
      case "tick":
      case "alarm":
        return tick(event._tag === "alarm")
      case "settings":
        return targets.apply
      case "relay-code-list":
        return Effect.flatMap(scheduleNow, (now) =>
          codeList.relayNow(ajaibRest, now, (state) =>
            saveCodeListRelay({ state, at: Date.now() })
          )
        )
    }
  }
  return yield* Effect.forever(Effect.flatMap(Queue.take(events), handle))
})

Effect.runFork(
  main.pipe(
    Effect.scoped,
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
    Effect.tapCause((cause) => Effect.logError("Relay stopped", cause))
  )
)
