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
  Cause,
  DateTime,
  Duration,
  Effect,
  Fiber,
  FiberMap,
  Logger,
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
import { doneDetailsStore } from "./broker-codes/done-details-store.ts"
import { makeDoneDetailsWalk } from "./broker-codes/done-details-walk.ts"
import { makeExtraTarget } from "./broker-codes/extra-target.ts"
import { brokerCodesTargets, fetchSend } from "./broker-codes/poster.ts"
import { makeProductionTarget } from "./broker-codes/production-target.ts"
import { makeTargetHold, type TargetHold } from "./broker-codes/target-hold.ts"
import { makeHistoryWalk } from "./broker-codes/history.ts"
import { ScheduleClock, scheduleNow } from "./broker-codes/hours.ts"
import { makeProgress } from "./broker-codes/progress.ts"
import { makeRunQueue } from "./broker-codes/run-queue.ts"
import { fetchGet } from "./broker-codes/status.ts"
import {
  makeStockbitWalk,
  stockbitCatchUp,
} from "./broker-codes/stockbit-walk.ts"
import { BATCH_INTERVAL, makeBatcher } from "./batch.ts"
import { ajaib, ajaibOnDemand, stockbit, type TabRequest } from "./broker.ts"
import { makeCodeList } from "./code-list.ts"
import { makeErrorLog } from "./error-log.ts"
import { windowAt } from "./gate.ts"
import { makeOnDemandCodes } from "./on-demand-codes.ts"
import { makePacer } from "./pacer.ts"
import {
  DashboardOrigin,
  ajaibCatchUpStore,
  ajaibWalkStore,
  clearRelayStopped,
  codeListStore,
  errorLogStore,
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
  loadPageRequest,
  savePageRequest,
  saveBrokerCodesProgress,
  saveBrokerCodesRun,
  saveCodeListRelay,
  saveRelayStopped,
  loadThrottled,
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
import { withChromeCookies } from "./stockbit.ts"
import { makeBrokerTab, type BrokerTab } from "./tab.ts"
import { relayScheduler } from "./scheduler.ts"
import { runTarget } from "./target.ts"

// Decision: the worker ticks every 10 s, woken by a 30 s chrome.alarms alarm
// (apps/extension/docs/adr/0012-the-service-worker-ticks-every-10-s-woken-by-an-alarm.md)
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
// Each stored change the worker acts on, and the event it queues. The badge
// follows the target states, the Ajaib tab's lock and the broker codes
// progress.
const storageEvents = Effect.fnUntraced(function* (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string
) {
  const checks = [
    [isSettingsChange, { _tag: "settings" }],
    [isCodeListRelayAsk, { _tag: "relay-code-list" }],
    [isClockOffsetChange, { _tag: "tick" }],
    [isBrokerCodesRunAsk, { _tag: "broker-codes-run" }],
  ] as const
  const found: Array<WorkerEvent> = []
  for (const [check, event] of checks)
    if (yield* check(changes, area)) found.push(event)
  const paused = yield* brokerCodesPausedChange(changes, area)
  if (Option.isSome(paused))
    found.push({ _tag: "broker-codes-paused", paused: paused.value })
  const badge = [
    isTargetStatesChange,
    isAjaibLockChange,
    isBrokerCodesProgressChange,
  ]
  for (const check of badge)
    if (yield* check(changes, area))
      return [...found, { _tag: "badge" } as const]
  return found
})
chrome.storage.onChanged.addListener((changes, area) => {
  for (const event of Effect.runSync(storageEvents(changes, area))) queue(event)
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
  // Each target's broker codes state under its settings (target-hold.ts),
  // shown over its socket's state.
  readonly holds: Record<TargetName, TargetHold>
}) {
  const { receive, holds } = options
  const fibers = yield* FiberMap.make<TargetName>()
  const states: Record<TargetName, TargetState> = {
    production: "off",
    extra: "off",
  }
  const shown = Effect.gen(function* () {
    const over = (name: TargetName) =>
      Effect.map(
        holds[name].state,
        Option.getOrElse(() => states[name])
      )
    return {
      production: yield* over("production"),
      extra: yield* over("extra"),
    } satisfies TargetStates
  })
  const show = Effect.flatMap(shown, saveTargetStates)
  // A target that isn't connected wants no on-demand codes.
  const report = (name: TargetName) => (state: TargetState) =>
    Effect.suspend(() => {
      states[name] = state
      return Effect.andThen(
        show,
        state === "connected" ? Effect.void : receive(name, undefined)
      )
    })
  const restart = Effect.fnUntraced(function* (
    name: TargetName,
    target: Settings["extra"]
  ) {
    yield* holds[name].restart(
      Option.filter(Option.fromNullOr(target), ({ token }) => token !== "")
    )
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
  yield* show
  yield* apply
  return { apply, show }
})

// Now on the real clock and on the relay's schedule clock, and the offset
// between them.
const clocks = Effect.gen(function* () {
  const now = yield* DateTime.now
  const offset = yield* loadClockOffset
  return { now, offset, schedule: DateTime.add(now, { milliseconds: offset }) }
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
  // The websocket key fetch goes with the backfill, served first:
  // the live feed has no socket until it answers.
  const stockbitCodes: Subscriptions = yield* makeStockbitSubscriptions(
    codeList.codes,
    Effect.sync(() => stockbitPacer.tab("backfill"))
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
    pageRequests: { load: loadPageRequest, save: savePageRequest },
  })
  const tabs = [stockbitTab, ajaibTab]
  const ajaibLock = yield* makeAjaibLock({
    tab: ajaibTab,
    pins: sessionPinStore,
    save: saveAjaibLock,
  })
  yield* Effect.forkScoped(ajaibLock.run)
  yield* Effect.forkScoped(ajaibLock.keepAlive)
  // The Ajaib tab's REST calls, with the PIN sign-in's token for the page's
  // API before the page made a call of its own.
  const withToken = (request: TabRequest) =>
    request._tag === "page-fetch"
      ? Effect.map(
          Effect.suspend(() => ajaibSession.fallbackToken),
          (token) =>
            Option.isSome(token) ? { ...request, token: token.value } : request
        )
      : Effect.succeed(request)
  const ajaibRest: BrokerTab = {
    ...ajaibTab,
    awaitAnswer: (request) =>
      Effect.flatMap(withToken(request), ajaibTab.awaitAnswer),
  }
  // Every REST call on a site goes through the site's pacer, which keeps a
  // throttle stored before the service worker restarted.
  const throttled = yield* loadThrottled
  const stockbitPacer = yield* makePacer({
    feed: "Stockbit",
    tab: withChromeCookies(stockbitTab),
    throttled: (until) => saveThrottled("Stockbit", until),
    stoppedUntil: throttled.Stockbit,
  })
  const ajaibPacer = yield* makePacer({
    feed: "Ajaib",
    tab: ajaibRest,
    throttled: (until) => saveThrottled("Ajaib", until),
    stoppedUntil: throttled.Ajaib,
  })
  yield* Effect.forkScoped(stockbitPacer.run)
  yield* Effect.forkScoped(ajaibPacer.run)
  // The Ajaib backfill's paced calls, and whether their tab is still there.
  // The code list feeds Market Live's search, so it goes with the backfill.
  const ajaibBackfillTab = {
    ...ajaibPacer.tab("backfill"),
    attached: ajaibTab.attached,
  }
  // The PIN check goes with the backfill, served first: it is the
  // owner's own action, and a walk's queue would keep them waiting.
  const ajaibSession = yield* makeAjaibSession({
    tab: ajaibBackfillTab,
    store: sessionPinStore,
  })
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
  const targetsNow = Effect.flatMap(loadSettings, brokerCodesTargets)
  const productionTarget = Effect.map(targetsNow, (now) => now.production)
  const showTargets: Effect.Effect<void> = Effect.suspend(() => targets.show)
  const holds = {
    production: yield* makeTargetHold(showTargets),
    extra: yield* makeTargetHold(showTargets),
  }
  const production = yield* makeProductionTarget({
    target: productionTarget,
    send: fetchSend,
    get: fetchGet,
    hold: holds.production,
  })
  const extra = yield* makeExtraTarget({
    production: productionTarget,
    send: fetchSend,
    get: fetchGet,
    hold: holds.extra,
  })
  yield* Effect.forkScoped(extra.run)
  // What the options page and the badge show of the walks (progress.ts).
  const progress = yield* makeProgress(saveBrokerCodesProgress)
  // The Ajaib walks' paced calls, and whether their tab is still there.
  const ajaibWalkTab = {
    ...ajaibPacer.tab("walk"),
    attached: ajaibTab.attached,
    reload: ajaibTab.reload,
  }
  // The trades Ajaib's walk keeps for its Done Details walk, which then
  // gives them their order numbers before Stockbit's walk.
  const keptTrades = yield* doneDetailsStore
  const ajaibWalk = yield* makeAjaibWalk({
    tab: ajaibWalkTab,
    post: extra.tee(production.post),
    store: yield* ajaibWalkStore,
    trades: progress.trades,
    phase: progress.phase,
    keep: keptTrades.keep,
  })
  const doneDetailsWalk = yield* makeDoneDetailsWalk({
    tab: ajaibWalkTab,
    post: extra.tee(production.post),
    store: keptTrades,
    codes: progress.codes,
    phase: progress.phase,
  })
  // The Stockbit walks' paced calls, and whether their tab is still there.
  const stockbitWalkTab = {
    ...stockbitPacer.tab("walk"),
    attached: stockbitTab.attached,
  }
  const stockbitWalk = yield* makeStockbitWalk({
    tab: stockbitWalkTab,
    post: extra.tee(production.post),
    status: production.status,
    trades: progress.trades,
    signedOut: progress.signedOut,
  })
  const ajaibCatchUp = yield* extra.catchUp("Ajaib", ({ post, origin }) =>
    Effect.flatMap(ajaibCatchUpStore(origin), (store) =>
      makeAjaibWalk({ tab: ajaibWalkTab, post, store })
    )
  )
  // Then the order numbers it holds fewer of than Production: the Done
  // Details walk's held trades, then Stockbit's whole day.
  const ordersCatchUp = extra.ordersCatchUp({
    ajaib: doneDetailsWalk.resend,
    stockbit: (day, post) =>
      Effect.flatMap(
        makeStockbitWalk({
          tab: stockbitWalkTab,
          post,
          status: production.status,
          signedOut: progress.signedOut,
        }),
        (walk) => walk.whole(day)
      ),
  })
  // Stockbit fills what the Ajaib catch-up left, from the extra target's
  // own missing ranges.
  const stockbitExtraCatchUp = yield* extra.catchUp(
    "Stockbit",
    ({ post, status }) =>
      stockbitCatchUp({
        tab: stockbitWalkTab,
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
    incompleteDays: incompleteDaysStore,
    catchUp: stockbitExtraCatchUp,
    catchUpStore: yield* historyCatchUpStore(extra.origin),
    report: progress.report,
  })
  const brokerCodes = yield* makeRunQueue({
    // Decision: walk order: Ajaib tape, then Done Details, then Stockbit
    // (apps/extension/docs/adr/0013-walk-order-ajaib-tape-done-details-then-stockbit.md)
    newestDay: [
      { feed: "Ajaib", walk: ajaibWalk.walk },
      { feed: "Ajaib", route: "done-details", walk: doneDetailsWalk.walk },
      { feed: "Stockbit", walk: stockbitWalk.walk },
    ],
    incompleteDays: incompleteDaysStore,
    status: production.status,
    gaps: { feed: "Stockbit", walk: stockbitWalk.gaps },
    history,
    catchUp: [ajaibCatchUp, ordersCatchUp, stockbitExtraCatchUp],
    gapsCatchUp: stockbitExtraCatchUp,
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
    holds,
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
    const fetch = yield* codeList.tick(ajaibBackfillTab, schedule)
    const earlier = settled
    settled = Option.some(
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* Fiber.awaitAll([
            ...Option.toArray(earlier),
            session,
            ...Option.toArray(fetch),
          ])
          // Decision: a test-only clock offset moves the relay's schedule for e2e
          // (apps/extension/docs/adr/0006-a-test-only-clock-offset-moves-the-relay-s-schedule.md)
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
          codeList.relayNow(ajaibBackfillTab, now, (state) =>
            saveCodeListRelay({ state, at: Date.now() })
          )
        )
    }
  }
  yield* showBadge
  return yield* Effect.forever(Effect.flatMap(Queue.take(events), handle))
})

Effect.runFork(
  Effect.andThen(clearRelayStopped, main).pipe(
    Effect.scoped,
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
    Effect.provideService(
      ScheduleClock,
      Effect.map(clocks, ({ schedule }) => schedule)
    ),
    Effect.tapCause((cause) =>
      Effect.andThen(
        Effect.logError("Relay stopped", cause),
        saveRelayStopped({ at: Date.now(), cause: Cause.pretty(cause) })
      )
    ),
    // Every fiber's Error and Fatal lines, "Relay stopped" included, also go
    // to session storage for the options page's diagnostics.
    Effect.provide(
      Logger.layer([makeErrorLog(errorLogStore)], { mergeWithExisting: true })
    ),
    // Every fiber runs on the relay scheduler, which yields through a
    // `MessageChannel` message. Effect's default `setTimeout(0)` yields nest
    // under a backlog, and Chrome clamps nested timers to 4 ms: about 250
    // events a second. One provision covers every loop; none gets
    // `disableYield`. See apinrdw/kumora#229.
    Effect.provideService(Scheduler.Scheduler, relayScheduler)
  )
)
