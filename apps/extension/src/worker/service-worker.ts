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
  Fiber,
  FiberMap,
  Option,
  PubSub,
  Queue,
  Schedule,
  Scheduler,
  SubscriptionRef,
  type Scope,
} from "effect"
import * as Socket from "effect/socket/Socket"

import { makeAjaibLock } from "./ajaib-lock.ts"
import { makeAjaibSession } from "./ajaib-session.ts"
import { makeBackfill } from "./backfill.ts"
import { badgeOf } from "./badge.ts"
import { makeAjaibWalk } from "./broker-codes/ajaib-walk.ts"
import { makeExtraTarget } from "./broker-codes/extra-target.ts"
import {
  fetchSend,
  fetchStatus,
  makeBrokerCodesPoster,
} from "./broker-codes/poster.ts"
import { makeHistoryWalk } from "./broker-codes/history.ts"
import { makeProgress } from "./broker-codes/progress.ts"
import { makeRunQueue } from "./broker-codes/run-queue.ts"
import { fetchGet, makeBrokerCodesStatus } from "./broker-codes/status.ts"
import {
  makeStockbitWalk,
  stockbitCatchUp,
} from "./broker-codes/stockbit-walk.ts"
import { BATCH_INTERVAL, makeBatcher } from "./batch.ts"
import { ajaib, ajaibOnDemand, stockbit } from "./broker.ts"
import { makeCodeList } from "./code-list.ts"
import { windowAt } from "./gate.ts"
import { makeOnDemandCodes } from "./on-demand-codes.ts"
import { makePacer } from "./pacer.ts"
import {
  DashboardOrigin,
  ajaibCatchUpStore,
  ajaibWalkStore,
  codeListStore,
  historyCatchUpStore,
  historyStore,
  incompleteDaysStore,
  isClockOffsetChange,
  isAjaibLockChange,
  isBrokerCodesProgressChange,
  isBrokerCodesRunAsk,
  isCodeListRelayAsk,
  isSettingsChange,
  isTargetStatesChange,
  brokerCodesPausedChange,
  loadAjaibLock,
  loadBrokerCodesPaused,
  loadBrokerCodesProgress,
  loadClockOffset,
  loadSettings,
  loadTargetStates,
  saveAjaibLock,
  saveBrokerCodesProgress,
  saveBrokerCodesRun,
  saveCodeListRelay,
  saveThrottled,
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
import { relayScheduler } from "./scheduler.ts"
import { runTarget } from "./target.ts"

// Decision: the service worker ticks every 10 s; in-tab timers are throttled
// in background tabs and never relied on. A `chrome.alarms` alarm (30 s, its
// shortest period) wakes a worker Chrome stopped, and ticks only when the
// in-worker timer is overdue. See apinrdw/kumora#59.
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
  | { readonly _tag: "broker-codes-paused"; readonly paused: boolean }
  | { readonly _tag: "broker-codes-run" }
  | { readonly _tag: "badge" }

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
  const paused = Effect.runSync(brokerCodesPausedChange(changes, area))
  if (Option.isSome(paused))
    queue({ _tag: "broker-codes-paused", paused: paused.value })
  if (Effect.runSync(isBrokerCodesRunAsk(changes, area)))
    queue({ _tag: "broker-codes-run" })
  if (
    Effect.runSync(isTargetStatesChange(changes, area)) ||
    Effect.runSync(isAjaibLockChange(changes, area)) ||
    Effect.runSync(isBrokerCodesProgressChange(changes, area))
  )
    queue({ _tag: "badge" })
})

// The toolbar badge follows what the worker stores: the target states, the
// Ajaib tab's lock and the broker codes progress (badge.ts).
const showBadge = Effect.gen(function* () {
  const { text, title } = yield* badgeOf({
    states: yield* loadTargetStates,
    lock: yield* loadAjaibLock,
    progress: yield* loadBrokerCodesProgress,
  })
  yield* Effect.promise(() => chrome.action.setBadgeText({ text }))
  yield* Effect.promise(() => chrome.action.setTitle({ title }))
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
  // A 401 or 426 to a broker codes POST: shown over the socket's state until
  // the target's settings change.
  const stops: Partial<Record<TargetName, TargetState>> = {}
  const shown = Effect.sync((): TargetStates => ({
    production: stops.production ?? states.production,
    extra: stops.extra ?? states.extra,
  }))
  // A target that isn't connected wants no on-demand codes.
  const report = (name: TargetName) => (state: TargetState) =>
    Effect.suspend(() => {
      states[name] = state
      return Effect.andThen(
        Effect.flatMap(shown, saveTargetStates),
        state === "connected" ? Effect.void : receive(name, undefined)
      )
    })
  const stop = (name: TargetName, state: TargetState) =>
    Effect.suspend(() => {
      stops[name] = state
      return Effect.flatMap(shown, saveTargetStates)
    })
  const restart = Effect.fnUntraced(function* (
    name: TargetName,
    target: Settings["extra"]
  ) {
    delete stops[name]
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
  yield* Effect.flatMap(shown, saveTargetStates)
  yield* apply
  return { apply, stop }
})

// Now on the real clock and on the relay's schedule clock, and the offset
// between them.
const clocks = Effect.gen(function* () {
  const now = yield* DateTime.now
  const offset = yield* loadClockOffset
  return { now, offset, schedule: DateTime.add(now, { milliseconds: offset }) }
})
const scheduleNow = Effect.map(clocks, ({ schedule }) => schedule)

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
    page: (event): Effect.Effect<void> =>
      Effect.suspend(() => ajaibLock.page(event)),
  })
  const tabs = [stockbitTab, ajaibTab]
  const ajaibSession = yield* makeAjaibSession({
    tab: ajaibTab,
    store: sessionPinStore,
  })
  const ajaibLock = yield* makeAjaibLock({
    tab: ajaibTab,
    pins: sessionPinStore,
    save: saveAjaibLock,
  })
  yield* Effect.forkScoped(ajaibLock.run)
  yield* Effect.forkScoped(ajaibLock.keepAlive)
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
  // Every REST call on a site goes through the site's pacer.
  const stockbitPacer = yield* makePacer({
    feed: "Stockbit",
    tab: stockbitTab,
    throttled: (until) => saveThrottled("Stockbit", until),
  })
  const ajaibPacer = yield* makePacer({
    feed: "Ajaib",
    tab: ajaibRest,
    throttled: (until) => saveThrottled("Ajaib", until),
  })
  yield* Effect.forkScoped(stockbitPacer.run)
  yield* Effect.forkScoped(ajaibPacer.run)
  const backfill = yield* makeBackfill({
    stockbit: stockbitPacer.tab("backfill"),
    ajaib: ajaibPacer.tab("backfill"),
    publish,
  })
  yield* Effect.forkScoped(backfill.run)
  // Broker codes: the newest closed day's walks, then Stockbit's gap walk of
  // older incomplete days, then the History walk, post to Production, and
  // resume from its status.
  // Each batch also goes to the extra target, which
  // then catches up on what it missed.
  const productionTarget = Effect.map(loadSettings, (settings) =>
    settings.productionToken === ""
      ? Option.none()
      : Option.some({
          origin: DashboardOrigin.make(__PRODUCTION_DASHBOARD__),
          token: settings.productionToken,
        })
  )
  const production = yield* makeBrokerCodesPoster({
    target: productionTarget,
    send: fetchSend,
  })
  const productionStatus = yield* makeBrokerCodesStatus({
    target: productionTarget,
    get: fetchGet,
  })
  const extraTarget = Effect.map(loadSettings, (settings) =>
    Option.filter(
      Option.fromNullOr(settings.extra),
      ({ token }) => token !== ""
    )
  )
  const extra = yield* makeExtraTarget({
    target: extraTarget,
    production: productionTarget,
    send: fetchSend,
    get: fetchStatus,
    report: (state) => Effect.suspend(() => targets.stop("extra", state)),
  })
  yield* Effect.forkScoped(extra.run)
  // What the options page and the badge show of the walks (progress.ts).
  const progress = yield* makeProgress(saveBrokerCodesProgress)
  const ajaibWalk = yield* makeAjaibWalk({
    tab: ajaibPacer.tab("walk"),
    post: extra.tee(production.post),
    store: yield* ajaibWalkStore,
    trades: progress.trades,
  })
  const stockbitWalk = yield* makeStockbitWalk({
    tab: stockbitPacer.tab("walk"),
    post: extra.tee(production.post),
    status: productionStatus.status,
    trades: progress.trades,
    signedOut: progress.signedOut,
  })
  const ajaibCatchUp = yield* extra.catchUp("Ajaib", ({ post }) =>
    Effect.flatMap(ajaibCatchUpStore, (store) =>
      makeAjaibWalk({ tab: ajaibPacer.tab("walk"), post, store })
    )
  )
  // Stockbit fills what the Ajaib catch-up left, from the extra target's
  // own missing ranges.
  const stockbitExtraCatchUp = yield* extra.catchUp(
    "Stockbit",
    ({ post, status }) =>
      stockbitCatchUp({
        tab: stockbitPacer.tab("walk"),
        post,
        status,
        signedOut: progress.signedOut,
      })
  )
  // The History walk: Stockbit's gap walk of each older day, which walks a
  // day with nothing held whole. The extra target follows it with the
  // Stockbit catch-up.
  const history = yield* makeHistoryWalk({
    walk: { feed: "Stockbit", walk: stockbitWalk.gaps },
    store: historyStore,
    catchUp: stockbitExtraCatchUp,
    catchUpStore: historyCatchUpStore(
      Effect.map(
        extraTarget,
        Option.map(({ origin }) => origin)
      )
    ),
    report: progress.report,
  })
  const brokerCodes = yield* makeRunQueue({
    newestDay: [
      { feed: "Ajaib", walk: ajaibWalk.walk },
      { feed: "Stockbit", walk: stockbitWalk.walk },
    ],
    incompleteDays: incompleteDaysStore,
    gaps: { feed: "Stockbit", walk: stockbitWalk.gaps },
    history,
    catchUp: [ajaibCatchUp, stockbitExtraCatchUp],
    paused: loadBrokerCodesPaused,
    report: progress.report,
  })
  yield* Effect.forkScoped(brokerCodes.run)
  // Today's WIB date on the schedule clock, moved on by the tick.
  const day = yield* SubscriptionRef.make(yield* wibDateAt(yield* scheduleNow))
  const targets = yield* makeTargets({
    envelopes,
    day,
    catchUp: codeList.catchUp,
    receive: onDemandCodes.receive,
  })

  // The tick, from the worker's own timer and the alarm. Its tab calls are
  // forked, since their answers queue behind it as worker events; `settled`
  // ends once the last tick's calls and every earlier tick's have answers.
  let lastTick = 0
  let settled = Option.none<Fiber.Fiber<void>>()
  const tick = Effect.fnUntraced(function* (alarm: boolean) {
    const { now, offset, schedule } = yield* clocks
    const ms = DateTime.toEpochMillis(now)
    if (alarm && ms - lastTick < Duration.toMillis(TICK)) return
    lastTick = ms
    const today = yield* wibDateAt(schedule)
    if (today !== (yield* SubscriptionRef.get(day)))
      yield* SubscriptionRef.set(day, today)
    const window = yield* windowAt(schedule)
    for (const tab of tabs) yield* tab.tick(window)
    const session = yield* Effect.forkScoped(ajaibSession.tick)
    yield* ajaibLock.tick
    yield* brokerCodes.tick
    const fetch = yield* codeList.tick(ajaibRest, schedule)
    const earlier = settled
    settled = Option.some(
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Fiber.awaitAll([
            ...Option.toArray(earlier),
            session,
            ...Option.toArray(fetch),
          ])
          // Decision: a completed tick (its PIN check, code list fetch and
          // every earlier tick's have answered) leaves its clock offset in
          // the worker's global scope, test-only, so a spec that moved the
          // clock awaits a tick on the new clock instead of sleeping.
          // See apinrdw/kumora#174.
          Object.assign(globalThis, { [LAST_TICK_KEY]: offset })
        })
      )
    )
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
      // A broker tab connecting starts a broker codes run, as does a
      // settings change, which may have fixed a token a walk stopped on.
      case "connect":
        return Effect.andThen(
          Effect.forEach(tabs, (tab) => tab.connect(event.port)),
          brokerCodes.trigger
        )
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
        return Effect.andThen(targets.apply, brokerCodes.trigger)
      // The owner's switch: on stops every walk, off (Resume) is a trigger.
      case "broker-codes-paused":
        return event.paused ? brokerCodes.pause : brokerCodes.trigger
      case "broker-codes-run":
        return Effect.andThen(
          brokerCodes.trigger,
          saveBrokerCodesRun("started")
        )
      case "badge":
        return showBadge
      case "relay-code-list":
        return Effect.flatMap(scheduleNow, (now) =>
          codeList.relayNow(ajaibRest, now, (state) =>
            saveCodeListRelay({ state, at: Date.now() })
          )
        )
    }
  }
  yield* showBadge
  return yield* Effect.forever(Effect.flatMap(Queue.take(events), handle))
})

Effect.runFork(
  main.pipe(
    Effect.scoped,
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
    // Decision: every fiber runs on the relay scheduler, which yields through a
    // `MessageChannel` message. Effect's default `setTimeout(0)` yields nest
    // under a backlog, and Chrome clamps nested timers to 4 ms: about 250
    // events a second. One provision covers every loop; none gets
    // `disableYield`. See apinrdw/kumora#229.
    Effect.provideService(Scheduler.Scheduler, relayScheduler),
    Effect.tapCause((cause) => Effect.logError("Relay stopped", cause))
  )
)
