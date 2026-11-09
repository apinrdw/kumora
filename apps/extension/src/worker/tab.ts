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
const decodeFeed = Schema.decodeUnknownOption(Feed)

const REQUEST_TIMEOUT = "15 seconds"

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
  // The site whose connections are the feed's freshness: its opens and
  // closes go up as FeedStatus.
  readonly reporting: SiteName
  readonly batcher: Effect.Success<ReturnType<typeof makeBatcher>>
  readonly publish: (message: IngestUp) => Effect.Effect<unknown>
  readonly hooks: TabHooks
}) {
  const { feed, sites, batcher, publish, hooks } = options
  let active: chrome.runtime.Port | undefined
  const waiting: Array<chrome.runtime.Port> = []
  const links = new Map<SiteName, Links>(
    sites.map((site) => [site.name, detached])
  )
  const pending = new Map<number, Deferred.Deferred<Answer>>()
  let nextId = 0

  const post = (command: TabCommand) =>
    Effect.ignore(Effect.try(() => active?.postMessage(command)))

  const report = Effect.fnUntraced(function* (
    statuses: ReadonlyArray<{
      connection: Connection
      status: "opened" | "closed" | "alive"
    }>
  ) {
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
    if (site.name === options.reporting) yield* report(next.statuses)
    yield* notify(site.name, before, next.links)
  })
  const driveAll = (input: BrokerInput) =>
    Effect.forEach(sites, (site) => drive(site, input), { discard: true })

  const siteOf = (name: SiteName) => sites.find((site) => site.name === name)

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
    const site = siteOf(event.site)
    if (site === undefined) return
    if (event._tag === "frame")
      yield* batcher.add(feed, event.connection, event.payload)
    yield* drive(site, event)
  })

  const message = Effect.fnUntraced(function* (
    port: chrome.runtime.Port,
    raw: unknown
  ) {
    if (port !== active) return
    const answer = decodeAnswer(raw)
    if (Option.isSome(answer)) {
      const deferred = pending.get(answer.value.id)
      pending.delete(answer.value.id)
      if (deferred !== undefined)
        yield* Deferred.succeed(deferred, answer.value)
      return
    }
    const event = decodeBrokerEvent(raw)
    if (Option.isSome(event)) yield* onEvent(event.value)
  })

  const disconnect = Effect.fnUntraced(function* (port: chrome.runtime.Port) {
    const at = waiting.indexOf(port)
    if (at !== -1) waiting.splice(at, 1)
    if (port !== active) return
    active = undefined
    const gone: Answer = { _tag: "answer", id: -1, status: 0, body: "" }
    for (const deferred of pending.values())
      yield* Deferred.succeed(deferred, gone)
    pending.clear()
    yield* driveAll({ _tag: "detach" })
    const next = waiting.shift()
    if (next !== undefined) yield* attach(next)
  })

  // A request made from the tab's origin; none when the tab goes or doesn't
  // answer in time.
  const request = Effect.fnUntraced(function* (tabRequest: TabRequest) {
    if (active === undefined) return Option.none<Answer>()
    const id = nextId++
    const deferred = yield* Deferred.make<Answer>()
    pending.set(id, deferred)
    yield* post({ _tag: "request", id, request: tabRequest })
    const answer = yield* Effect.timeoutOption(
      Deferred.await(deferred),
      REQUEST_TIMEOUT
    )
    pending.delete(id)
    return Option.filter(answer, (received) => received.status !== 0)
  })

  const send = (site: SiteName, connection: Connection, payload: Payload) =>
    post({ _tag: "send", site, connection, payload })

  const drop = Effect.fnUntraced(function* (
    name: SiteName,
    connection: Connection
  ) {
    const site = siteOf(name)
    if (site !== undefined)
      yield* drive(site, { _tag: "drop", site: name, connection })
  })

  const isOpen = (site: SiteName, connection: Connection) =>
    links.get(site)?.[connection].phase === "open"

  const tab: BrokerTab = {
    connect,
    message,
    disconnect,
    tick: (window: Window) => driveAll({ _tag: "tick", window }),
    request,
    send,
    drop,
    isOpen,
    attached: () => active !== undefined,
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
  readonly send: (
    site: SiteName,
    connection: Connection,
    payload: Payload
  ) => Effect.Effect<void>
  readonly drop: (site: SiteName, connection: Connection) => Effect.Effect<void>
  readonly isOpen: (site: SiteName, connection: Connection) => boolean
  readonly attached: () => boolean
}
