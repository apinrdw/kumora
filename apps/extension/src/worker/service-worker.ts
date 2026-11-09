// The relay's service worker (spec apinrdw/kumora#138, "The extension"). It
// drives the broker tabs' connections on a 10 s tick, batches their frames,
// and sends the envelopes to every target's ingest socket.
import {
  Feed,
  IngestProtocolVersion,
  encodeIngestUp,
  type IngestUp,
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
  Schema,
} from "effect"
import * as Socket from "effect/socket/Socket"

import { BATCH_INTERVAL, makeBatcher } from "./batch.ts"
import {
  BrokerEvent,
  ajaib,
  detached,
  step,
  type BrokerInput,
  type Links,
} from "./broker.ts"
import {
  DashboardOrigin,
  isSettingsChange,
  loadSettings,
  saveTargetStates,
  type Settings,
  type TargetName,
  type TargetState,
  type TargetStates,
} from "./settings.ts"
import { runTarget } from "./target.ts"

// Decision: the service worker ticks every 10 s; in-tab timers are throttled
// in background tabs and never relied on. A `chrome.alarms` alarm (Chrome's
// shortest period, 30 s) wakes a worker Chrome stopped, and ticks only when
// the in-worker timer is overdue. See apinrdw/kumora#59.
const TICK = Duration.seconds(10)
const ALARM = "tick"

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
})

const decodeFeed = Schema.decodeUnknownOption(Feed)
const decodeBrokerEvent = Schema.decodeUnknownOption(BrokerEvent)

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
const makeTargets = Effect.fnUntraced(function* (
  envelopes: PubSub.PubSub<string>
) {
  const fibers = yield* FiberMap.make<TargetName>()
  const states: Record<TargetName, TargetState> = {
    production: "off",
    extra: "off",
  }
  const report = (name: TargetName) => (state: TargetState) =>
    Effect.suspend(() => {
      states[name] = state
      return showStates({ ...states })
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
      runTarget({ ...target, envelopes, report: report(name) })
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

// The broker tab. The first tab to connect is relayed; another waits until it
// goes.
const makeBrokerTab = Effect.fnUntraced(function* (
  publish: (message: IngestUp) => Effect.Effect<unknown>
) {
  const batcher = yield* makeBatcher()
  yield* Effect.forkScoped(
    Effect.repeat(
      Effect.flatMap(batcher.flush, (batch) => Effect.forEach(batch, publish)),
      Schedule.spaced(BATCH_INTERVAL)
    )
  )

  let active: chrome.runtime.Port | undefined
  const waiting: Array<chrome.runtime.Port> = []
  let links: Links = detached
  const drive = Effect.fnUntraced(function* (input: BrokerInput) {
    const next = yield* step(ajaib, links, input)
    links = next.links
    for (const command of next.commands)
      yield* Effect.ignore(Effect.try(() => active?.postMessage(command)))
    const at = yield* DateTime.now
    for (const { connection, status } of next.statuses)
      yield* publish({
        _tag: "FeedStatus",
        protocolVersion: IngestProtocolVersion,
        feed: ajaib.feed,
        connection,
        at,
        status,
      })
  })
  const attach = Effect.fnUntraced(function* (port: chrome.runtime.Port) {
    active = port
    yield* drive({ _tag: "attach" })
  })

  const connect = Effect.fnUntraced(function* (port: chrome.runtime.Port) {
    const feed = decodeFeed(port.name)
    if (Option.isNone(feed) || feed.value !== ajaib.feed) return
    if (active === undefined) yield* attach(port)
    else waiting.push(port)
  })
  const message = Effect.fnUntraced(function* (
    port: chrome.runtime.Port,
    raw: unknown
  ) {
    const event = decodeBrokerEvent(raw)
    if (port !== active || Option.isNone(event)) return
    if (event.value._tag === "frame")
      yield* batcher.add(event.value.connection, event.value.text)
    yield* drive(event.value)
  })
  const disconnect = Effect.fnUntraced(function* (port: chrome.runtime.Port) {
    const at = waiting.indexOf(port)
    if (at !== -1) waiting.splice(at, 1)
    if (port !== active) return
    active = undefined
    yield* drive({ _tag: "detach" })
    const next = waiting.shift()
    if (next !== undefined) yield* attach(next)
  })
  return { connect, message, disconnect, tick: drive({ _tag: "tick" }) }
})

const main = Effect.gen(function* () {
  const envelopes = yield* PubSub.sliding<string>(1024)
  const publish = (message: IngestUp) =>
    Effect.flatMap(Effect.orDie(encodeIngestUp(message)), (text) =>
      PubSub.publish(envelopes, text)
    )
  const targets = yield* makeTargets(envelopes)
  const tab = yield* makeBrokerTab(publish)

  // The tick, from the worker's own timer and the alarm.
  let lastTick = 0
  const tick = Effect.fnUntraced(function* (alarm: boolean) {
    const now = DateTime.toEpochMillis(yield* DateTime.now)
    if (alarm && now - lastTick < Duration.toMillis(TICK)) return
    lastTick = now
    yield* tab.tick
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

  const handle = (event: WorkerEvent) => {
    switch (event._tag) {
      case "connect":
        return tab.connect(event.port)
      case "message":
        return tab.message(event.port, event.message)
      case "disconnect":
        return tab.disconnect(event.port)
      case "tick":
      case "alarm":
        return tick(event._tag === "alarm")
      case "settings":
        return targets.apply
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
