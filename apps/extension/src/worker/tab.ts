// One broker tab as the service worker sees it (spec apinrdw/kumora#138,
// "Broker connections"): its port, the sockets of each of its sites, and the
// one-off requests it makes from its own origin. The first tab of a feed to
// connect is relayed; another waits until it goes.
import {
  Feed,
  IngestProtocolVersion,
  type Connection,
  type IngestUp,
} from "@workspace/relay"
import { DateTime, Deferred, Effect, Option, Schema } from "effect"

import type { makeBatcher } from "./batch.ts"
import {
  Answer,
  BrokerEvent,
  PageEvent,
  detached,
  step,
  type BrokerInput,
  type BrokerSite,
  type Links,
  type Payload,
  type SiteName,
  type TabCommand,
  type TabRequest,
  type Window,
} from "./broker.ts"

const decodeBrokerEvent = Schema.decodeUnknownOption(BrokerEvent)
const decodeAnswer = Schema.decodeUnknownOption(Answer)
const decodePageEvent = Schema.decodeUnknownOption(PageEvent)
const decodeFeed = Schema.decodeUnknownOption(Feed)

// How long a caller waits for the tab's answer. The pacer (pacer.ts) gives
// a caller up after it too, while the call keeps its slot.
export const REQUEST_TIMEOUT = "15 seconds"

const connections: ReadonlyArray<Connection> = ["A", "B"]

export interface TabHooks {
  // A site's socket opened, or stopped being open.
  readonly opened: (
    tab: BrokerTab,
    site: SiteName,
    connection: Connection
  ) => Effect.Effect<void>
  readonly closed: (
    tab: BrokerTab,
    site: SiteName,
    connection: Connection
  ) => Effect.Effect<void>
}

export const makeBrokerTab = Effect.fnUntraced(function* (options: {
  readonly feed: Feed
  readonly sites: ReadonlyArray<BrokerSite>
  readonly batcher: Effect.Success<ReturnType<typeof makeBatcher>>
  readonly publish: (message: IngestUp) => Effect.Effect<unknown>
  readonly hooks: TabHooks
  // What the page script sees of the page (Ajaib's lock screen). A tab that
  // goes reports its lock gone, or the lock of the tab that takes over.
  readonly page?: (event: PageEvent) => Effect.Effect<void>
}) {
  const { feed, sites, batcher, publish, hooks } = options
  const page = options.page ?? (() => Effect.void)
  let active: chrome.runtime.Port | undefined
  const waiting: Array<chrome.runtime.Port> = []
  // The lock each waiting tab's page last reported. Its page reports a lock
  // only when it changes, so the tab that takes over reports this one.
  const waitingLocks = new Map<chrome.runtime.Port, boolean>()
  const links = new Map<SiteName, Links>(
    sites.map((site) => [site.name, detached])
  )
  const pending = new Map<number, Deferred.Deferred<Answer>>()
  let nextId = 0

  const post = (command: TabCommand) =>
    Effect.ignore(Effect.try(() => active?.postMessage(command)))

  // Decision: a connection's buffered frames go up before its close, drained
  // from the batcher here rather than left to the 250 ms flush, so a frame
  // never follows its connection's close and revives one the dashboard was
  // told is closed. That is the only order the tab fixes: an opened or alive
  // status goes up at once, ahead of frames batched before it.
  const report = Effect.fnUntraced(function* (
    statuses: ReadonlyArray<{
      connection: Connection
      status: "opened" | "closed" | "alive"
    }>
  ) {
    for (const { connection, status } of statuses)
      if (status === "closed")
        yield* Effect.forEach(yield* batcher.drain(feed, connection), publish)
    const at = yield* DateTime.now
    for (const { connection, status } of statuses)
      yield* publish({
        _tag: "FeedStatus",
        protocolVersion: IngestProtocolVersion,
        feed,
        connection,
        at,
        status,
      })
  })

  const notify = Effect.fnUntraced(function* (
    site: SiteName,
    before: Links,
    after: Links
  ) {
    for (const connection of connections) {
      const was = before[connection].phase === "open"
      const is = after[connection].phase === "open"
      if (!was && is) yield* hooks.opened(tab, site, connection)
      if (was && !is) yield* hooks.closed(tab, site, connection)
    }
  })

  const drive = Effect.fnUntraced(function* (
    site: BrokerSite,
    input: BrokerInput
  ) {
    const before = links.get(site.name) ?? detached
    const next = yield* step(site, before, input)
    links.set(site.name, next.links)
    for (const command of next.commands) yield* post(command)
    if (site.stream === "trade") yield* report(next.statuses)
    yield* notify(site.name, before, next.links)
  })
  const driveAll = (input: BrokerInput) =>
    Effect.forEach(sites, (site) => drive(site, input), { discard: true })

  const siteOf = (name: SiteName) =>
    Effect.sync(() => sites.find((site) => site.name === name))

  const attach = Effect.fnUntraced(function* (port: chrome.runtime.Port) {
    active = port
    yield* driveAll({ _tag: "attach" })
  })

  const connect = Effect.fnUntraced(function* (port: chrome.runtime.Port) {
    // Ports of other feeds belong to the other tab.
    const named = decodeFeed(port.name)
    if (Option.isNone(named) || named.value !== feed) return
    if (active === undefined) yield* attach(port)
    else waiting.push(port)
  })

  const onEvent = Effect.fnUntraced(function* (event: BrokerEvent) {
    const site = yield* siteOf(event.site)
    if (site === undefined) return
    if (event._tag === "frame")
      yield* batcher.add(site, event.connection, event.payload)
    yield* drive(site, event)
  })

  const message = Effect.fnUntraced(function* (
    port: chrome.runtime.Port,
    raw: unknown
  ) {
    if (port !== active) {
      const seen = decodePageEvent(raw)
      if (Option.isSome(seen) && seen.value._tag === "lock")
        waitingLocks.set(port, seen.value.locked)
      return
    }
    const answer = decodeAnswer(raw)
    if (Option.isSome(answer)) {
      const deferred = pending.get(answer.value.id)
      pending.delete(answer.value.id)
      if (deferred !== undefined)
        yield* Deferred.succeed(deferred, answer.value)
      return
    }
    const event = decodeBrokerEvent(raw)
    if (Option.isSome(event)) return yield* onEvent(event.value)
    const seen = decodePageEvent(raw)
    if (Option.isSome(seen)) yield* page(seen.value)
  })

  const disconnect = Effect.fnUntraced(function* (port: chrome.runtime.Port) {
    const at = waiting.indexOf(port)
    if (at !== -1) waiting.splice(at, 1)
    waitingLocks.delete(port)
    if (port !== active) return
    active = undefined
    const gone: Answer = { _tag: "answer", id: -1, status: 0, body: "" }
    for (const deferred of pending.values())
      yield* Deferred.succeed(deferred, gone)
    pending.clear()
    yield* driveAll({ _tag: "detach" })
    const next = waiting.shift()
    if (next === undefined) return yield* page({ _tag: "lock", locked: false })
    const locked = waitingLocks.get(next) ?? false
    waitingLocks.delete(next)
    yield* attach(next)
    yield* page({ _tag: "lock", locked })
  })

  // A request made from the tab's origin, waited for until the tab answers;
  // none when the tab goes.
  const awaitAnswer = Effect.fnUntraced(function* (tabRequest: TabRequest) {
    if (active === undefined) return Option.none<Answer>()
    const id = nextId++
    const deferred = yield* Deferred.make<Answer>()
    pending.set(id, deferred)
    return yield* Effect.ensuring(
      Effect.gen(function* () {
        yield* post({ _tag: "request", id, request: tabRequest })
        const answer = yield* Deferred.await(deferred)
        return answer.status === 0 ? Option.none<Answer>() : Option.some(answer)
      }),
      Effect.sync(() => pending.delete(id))
    )
  })

  // The same, none too when the tab doesn't answer in time.
  const request = (tabRequest: TabRequest) =>
    Effect.map(
      Effect.timeoutOption(awaitAnswer(tabRequest), REQUEST_TIMEOUT),
      Option.flatten
    )

  const send = (site: SiteName, connection: Connection, payload: Payload) =>
    post({ _tag: "send", site, connection, payload })

  const drop = Effect.fnUntraced(function* (
    name: SiteName,
    connection: Connection
  ) {
    const site = yield* siteOf(name)
    if (site !== undefined)
      yield* drive(site, { _tag: "drop", site: name, connection })
  })

  const isOpen = (site: SiteName, connection: Connection) =>
    Effect.sync(() => links.get(site)?.[connection].phase === "open")

  const tab: BrokerTab = {
    connect,
    message,
    disconnect,
    tick: (window: Window) => driveAll({ _tag: "tick", window }),
    request,
    awaitAnswer,
    send,
    drop,
    isOpen,
    attached: Effect.sync(() => active !== undefined),
  }
  return tab
})

export interface BrokerTab {
  readonly connect: (port: chrome.runtime.Port) => Effect.Effect<void>
  readonly message: (
    port: chrome.runtime.Port,
    raw: unknown
  ) => Effect.Effect<void>
  readonly disconnect: (port: chrome.runtime.Port) => Effect.Effect<void>
  readonly tick: (window: Window) => Effect.Effect<void>
  readonly request: (
    request: TabRequest
  ) => Effect.Effect<Option.Option<Answer>>
  readonly awaitAnswer: (
    request: TabRequest
  ) => Effect.Effect<Option.Option<Answer>>
  readonly send: (
    site: SiteName,
    connection: Connection,
    payload: Payload
  ) => Effect.Effect<void>
  readonly drop: (site: SiteName, connection: Connection) => Effect.Effect<void>
  readonly isOpen: (
    site: SiteName,
    connection: Connection
  ) => Effect.Effect<boolean>
  readonly attached: Effect.Effect<boolean>
}
