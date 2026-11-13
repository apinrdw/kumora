// A broker site's two connections, A and B, as the service worker drives them
// (spec apinrdw/kumora#138, "Broker connections" and "Heartbeat and
// reconnect"). The content script in the broker tab holds the sockets and does
// only what it is told; every decision is made here, on the service worker's
// tick, because timers inside a background tab are throttled.
import { Connection, type Feed, type FrameStream } from "@workspace/relay"
import { Effect, Schema } from "effect"

// One socket's message: Ajaib's JSON text, or Stockbit's protobuf bytes as
// base64 (a port carries JSON only).
const Payload = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({ base64: Schema.String }),
])
export type Payload = typeof Payload.Type

// The relay's sockets in a broker tab: Stockbit's one stream, and Ajaib's
// trade stream plus the three on-demand streams.
const SiteName = Schema.Literals([
  "stockbit",
  "ajaib-trade",
  "ajaib-price",
  "ajaib-indicative",
  "ajaib-order-book",
])
export type SiteName = typeof SiteName.Type

const socket = { site: SiteName, connection: Connection }

// Service worker → content script, over the tab's port.
export type BrokerCommand =
  // Open the socket, replacing any it has, and send `subscribe` once it
  // opens.
  | {
      readonly _tag: "open"
      readonly site: SiteName
      readonly connection: Connection
      readonly url: string
      readonly protocols: ReadonlyArray<string>
      readonly subscribe: ReadonlyArray<Payload>
    }
  | {
      readonly _tag: "send"
      readonly site: SiteName
      readonly connection: Connection
      readonly payload: Payload
    }
  // Close the socket without reporting it.
  | {
      readonly _tag: "close"
      readonly site: SiteName
      readonly connection: Connection
    }

// A one-off request the tab makes from its own origin, answered by an
// `answer` event with the same id.
export type TabRequest =
  // A cookie's value, "" when it is missing.
  | { readonly _tag: "cookie"; readonly name: string }
  | {
      readonly _tag: "fetch"
      readonly url: string
      readonly headers: Readonly<Record<string, string>>
    }
  // A GET of `path` on the page's own REST API with the page's own headers,
  // as the MAIN-world wrapper last saw them. Before it saw any, `token` (the
  // PIN sign-in's) stands in on Ajaib's API host; status 0 without either.
  | {
      readonly _tag: "page-fetch"
      readonly path: string
      readonly token?: string
    }
  // A JSON POST from the tab, with its cookies and the page's headers.
  | { readonly _tag: "page-post"; readonly url: string; readonly body: string }
  // The bearer token of the page's latest REST request; status 0 before it
  // made one.
  | { readonly _tag: "page-token" }
  // Ajaib: one synthetic `mousemove` on the page's document, which re-arms
  // its idle PIN lock (ajaib-lock.ts).
  | { readonly _tag: "activity" }
  // Ajaib: type the PIN into the lock screen's six boxes. Status 200 once
  // typed, 404 when no lock screen shows, so nothing was typed.
  | { readonly _tag: "type-pin"; readonly pin: string }

export type TabCommand =
  | BrokerCommand
  | {
      readonly _tag: "request"
      readonly id: number
      readonly request: TabRequest
    }

// Status 0: the request failed before any answer.
export const Answer = Schema.TaggedStruct("answer", {
  id: Schema.Int,
  status: Schema.Int,
  body: Schema.String,
})
export type Answer = typeof Answer.Type

// Content script → service worker. The port is a process boundary, so the
// worker decodes it.
export const BrokerEvent = Schema.Union([
  Schema.TaggedStruct("opened", socket),
  Schema.TaggedStruct("frame", { ...socket, payload: Payload }),
  Schema.TaggedStruct("closed", { ...socket, code: Schema.Int }),
])
export type BrokerEvent = typeof BrokerEvent.Type

// What Ajaib's page script (page.ts) sees of the page, by way of the content
// script: the PIN lock screen showing or gone, and the answer status of the
// page's own PIN validate call.
export const PageEvent = Schema.Union([
  Schema.TaggedStruct("lock", { locked: Schema.Boolean }),
  Schema.TaggedStruct("pin-validated", { status: Schema.Int }),
])
export type PageEvent = typeof PageEvent.Type

// How the relay talks to one broker socket.
export interface BrokerSite {
  readonly name: SiteName
  readonly feed: Feed
  // The trade tape's sockets are the feed's freshness: their opens and closes
  // go up as feed status and their frames as signs of life. An on-demand
  // stream's frames go up marked as such.
  readonly stream: FrameStream
  readonly url: string
  readonly protocols: ReadonlyArray<string>
  // Sent by the tab as the socket opens. Stockbit's and the on-demand
  // streams' subscriptions change during the day, so the service worker
  // sends those itself.
  readonly subscribe: ReadonlyArray<Payload>
  // The app-level ping a quiet socket sends on a tick.
  readonly ping: Payload
}

const AJAIB_PING: Payload = {
  text: '{"method":"SUBSCRIBE","streamObject":"PING-WEB"}',
}

// The page's own direct host; it authenticates with the tab's cookies.
const AJAIB_STREAMS = "wss://stream.ajaib.co.id:8009/ws"
const ajaibSocket = {
  feed: "Ajaib",
  stream: "on-demand",
  protocols: [],
  subscribe: [],
  ping: AJAIB_PING,
} as const

// The whole-market tape. Its TRADE subscribe goes once, as the socket opens,
// from the service worker, so it can carry the account id (subscriptions.ts).
export const ajaib: BrokerSite = {
  ...ajaibSocket,
  name: "ajaib-trade",
  stream: "trade",
  url: `${AJAIB_STREAMS}/trade`,
}

// The on-demand streams, subscribed per code (subscriptions.ts).
export const ajaibOnDemand: ReadonlyArray<BrokerSite> = [
  { ...ajaibSocket, name: "ajaib-price", url: `${AJAIB_STREAMS}/price` },
  {
    ...ajaibSocket,
    name: "ajaib-indicative",
    url: `${AJAIB_STREAMS}/indicative`,
  },
  {
    ...ajaibSocket,
    name: "ajaib-order-book",
    url: `${AJAIB_STREAMS}/order-book-custom`,
  },
]

export const stockbit: BrokerSite = {
  name: "stockbit",
  feed: "Stockbit",
  stream: "trade",
  url: "wss://wss-jkt.trading.stockbit.com/ws",
  protocols: ["web"],
  subscribe: [],
  // WebsocketRequest { ping: { message: "ping" } }, bytes 22 06 0a 04 "ping".
  ping: { base64: "IgYKBHBpbmc=" },
}

// Where the trading day is for the relay: outside streaming hours nothing is
// open; during an auction a dropped socket reconnects but none opens fresh.
export type Window = "closed" | "auction" | "open"

interface Link {
  readonly phase: "idle" | "opening" | "open"
  // Anything arrived since the last tick.
  readonly heard: boolean
  // The last tick left an open or a ping unanswered.
  readonly waiting: boolean
  // A frame arrived on this socket.
  readonly framed: boolean
  // This connection was open earlier in today's streaming hours, so opening
  // it again is a reconnect.
  readonly ever: boolean
}

// A broker site's connections while a tab of it is attached.
export interface Links {
  readonly window: Window
  readonly attached: boolean
  readonly A: Link
  readonly B: Link
}

const idle: Link = {
  phase: "idle",
  heard: false,
  waiting: false,
  framed: false,
  ever: false,
}

export const detached: Links = {
  window: "closed",
  attached: false,
  A: idle,
  B: idle,
}

export type FeedStatus = "opened" | "closed" | "alive"

export type BrokerInput =
  | { readonly _tag: "attach" }
  | { readonly _tag: "detach" }
  | { readonly _tag: "tick"; readonly window: Window }
  // The relay gave up on a socket (Stockbit's key fetch failed): close it and
  // reopen it on the next tick.
  | {
      readonly _tag: "drop"
      readonly site: SiteName
      readonly connection: Connection
    }
  | BrokerEvent

export interface Step {
  readonly links: Links
  readonly commands: ReadonlyArray<BrokerCommand>
  readonly statuses: ReadonlyArray<{
    readonly connection: Connection
    readonly status: FeedStatus
  }>
}

const connections: ReadonlyArray<Connection> = ["A", "B"]

// One step's output, built up by the handlers below.
interface Draft {
  readonly site: BrokerSite
  readonly links: Links
  readonly next: { -readonly [K in keyof Links]: Links[K] }
  readonly commands: Array<BrokerCommand>
  readonly statuses: Array<Step["statuses"][number]>
}

const open = Effect.fnUntraced(function* (
  draft: Draft,
  connection: Connection
) {
  const { name: site, url, protocols, subscribe } = draft.site
  draft.commands.push({
    _tag: "open",
    site,
    connection,
    url,
    protocols,
    subscribe,
  })
  draft.next[connection] = {
    ...idle,
    phase: "opening",
    ever: draft.links[connection].ever,
  }
})

// A link the tick must (re)open: an idle A; an idle B once A streams; or one
// whose open or ping went unanswered for a whole tick. During an auction only
// a connection that was open before may open.
const isDue = Effect.fnUntraced(function* (
  draft: Draft,
  connection: Connection
) {
  const link = draft.links[connection]
  if (draft.next.window !== "open" && !link.ever) return false
  if (link.phase !== "idle") return link.waiting
  return (
    connection === "A" || (draft.next.A.phase === "open" && draft.next.A.framed)
  )
})

const reopen = Effect.fnUntraced(function* (
  draft: Draft,
  connection: Connection
) {
  if (draft.links[connection].phase === "open")
    draft.statuses.push({ connection, status: "closed" })
  yield* open(draft, connection)
})

// A quiet socket: an open one pings, and either waits a tick for an answer.
const ping = Effect.fnUntraced(function* (
  draft: Draft,
  connection: Connection
) {
  const link = draft.links[connection]
  if (link.phase === "open")
    draft.commands.push({
      _tag: "send",
      site: draft.site.name,
      connection,
      payload: draft.site.ping,
    })
  draft.next[connection] = { ...link, waiting: true }
})

// At most one socket opens per tick, so A and B never open together and never
// drop together. A goes first; B opens for the first time only once A has
// streamed.
const onTick = Effect.fnUntraced(function* (draft: Draft, window: Window) {
  draft.next.window = window
  if (window === "closed") return yield* closeAll(draft)
  if (!draft.links.attached) return
  let opened = false
  for (const connection of connections) {
    const link = draft.links[connection]
    if (link.heard)
      draft.next[connection] = { ...link, heard: false, waiting: false }
    else if (yield* isDue(draft, connection)) {
      if (opened) continue
      yield* reopen(draft, connection)
      opened = true
    } else if (link.phase !== "idle") yield* ping(draft, connection)
  }
})

const onFrame = Effect.fnUntraced(function* (
  draft: Draft,
  connection: Connection
) {
  const link = draft.links[connection]
  if (link.waiting && link.phase === "open")
    draft.statuses.push({ connection, status: "alive" })
  draft.next[connection] = {
    ...link,
    heard: true,
    waiting: false,
    framed: true,
  }
})

const onClosed = Effect.fnUntraced(function* (
  draft: Draft,
  connection: Connection
) {
  const link = draft.links[connection]
  if (link.phase === "open")
    draft.statuses.push({ connection, status: "closed" })
  draft.next[connection] = { ...idle, ever: link.ever }
  if (draft.next.window === "closed") return
  // Decision: a socket that streamed reopens at once; one that closed before
  // its first frame waits for the next tick, so a broker refusing the relay
  // costs one attempt per 10 s rather than a tight loop.
  if (link.framed) yield* open(draft, connection)
})

const onDrop = Effect.fnUntraced(function* (
  draft: Draft,
  connection: Connection
) {
  const link = draft.links[connection]
  if (link.phase === "idle") return
  draft.commands.push({ _tag: "close", site: draft.site.name, connection })
  if (link.phase === "open")
    draft.statuses.push({ connection, status: "closed" })
  draft.next[connection] = { ...idle, ever: link.ever }
})

// Outside streaming hours: close every socket, and the next day starts fresh.
const closeAll = Effect.fnUntraced(function* (draft: Draft) {
  for (const connection of connections) {
    const link = draft.links[connection]
    if (link.phase !== "idle")
      draft.commands.push({ _tag: "close", site: draft.site.name, connection })
    if (link.phase === "open")
      draft.statuses.push({ connection, status: "closed" })
    draft.next[connection] = idle
  }
})

const onDetach = Effect.fnUntraced(function* (draft: Draft) {
  for (const connection of connections)
    if (draft.links[connection].phase === "open")
      draft.statuses.push({ connection, status: "closed" })
  Object.assign(draft.next, detached, { window: draft.links.window })
})

// One input applied to a site's links: the next links, the commands for the
// tab, and the feed statuses to send up.
export const step = Effect.fnUntraced(function* (
  site: BrokerSite,
  links: Links,
  input: BrokerInput
): Effect.fn.Return<Step> {
  const draft: Draft = {
    site,
    links,
    next: { ...links },
    commands: [],
    statuses: [],
  }
  switch (input._tag) {
    case "attach":
      draft.next.attached = true
      if (links.window === "open") yield* open(draft, "A")
      break
    case "detach":
      yield* onDetach(draft)
      break
    case "opened":
      draft.next[input.connection] = { ...idle, phase: "open", ever: true }
      draft.statuses.push({ connection: input.connection, status: "opened" })
      break
    case "frame":
      yield* onFrame(draft, input.connection)
      break
    case "closed":
      yield* onClosed(draft, input.connection)
      break
    case "drop":
      yield* onDrop(draft, input.connection)
      break
    case "tick":
      yield* onTick(draft, input.window)
      break
  }
  return {
    links: draft.next,
    commands: draft.commands,
    statuses: draft.statuses,
  }
})
