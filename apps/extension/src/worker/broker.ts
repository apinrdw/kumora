// A broker site's two connections, A and B, as the service worker drives them
// (spec apinrdw/kumora#138, "Broker connections" and "Heartbeat and
// reconnect"). The content script in the broker tab holds the sockets and does
// only what it is told; every decision is made here, on the service worker's
// tick, because timers inside a background tab are throttled.
import { Connection, type Feed } from "@workspace/relay"
import { Effect, Schema } from "effect"

// Service worker → content script, over the tab's port.
export type BrokerCommand =
  // Open the connection's socket, replacing any it has, and send `subscribe`
  // once it opens.
  | {
      readonly _tag: "open"
      readonly connection: Connection
      readonly url: string
      readonly subscribe: ReadonlyArray<string>
    }
  | {
      readonly _tag: "send"
      readonly connection: Connection
      readonly text: string
    }

// Content script → service worker. The port is a process boundary, so the
// worker decodes it.
export const BrokerEvent = Schema.Union([
  Schema.TaggedStruct("opened", { connection: Connection }),
  Schema.TaggedStruct("frame", { connection: Connection, text: Schema.String }),
  Schema.TaggedStruct("closed", { connection: Connection, code: Schema.Int }),
])
export type BrokerEvent = typeof BrokerEvent.Type

// How the relay talks to one broker's socket.
export interface BrokerSite {
  readonly feed: Feed
  readonly url: (connection: Connection) => string
  readonly subscribe: ReadonlyArray<string>
  // The app-level ping a quiet socket sends on a tick.
  readonly ping: string
}

export const ajaib: BrokerSite = {
  feed: "Ajaib",
  // The page's own direct host; it authenticates with the tab's cookies.
  url: () => "wss://stream.ajaib.co.id:8009/ws/trade",
  // The whole-market tape. Ajaib answers a second subscribe on the same
  // socket with `invalid subscription object`, so it is sent once.
  subscribe: ['{"method":"SUBSCRIBE","stream":"TRADE","streamObject":"*"}'],
  ping: '{"method":"SUBSCRIBE","streamObject":"PING-WEB"}',
}

interface Link {
  readonly phase: "idle" | "opening" | "open"
  // Anything arrived since the last tick.
  readonly heard: boolean
  // The last tick left an open or a ping unanswered.
  readonly waiting: boolean
  // A frame arrived on this socket.
  readonly framed: boolean
}

// A broker site's connections while a tab of it is attached.
export interface Links {
  readonly attached: boolean
  readonly A: Link
  readonly B: Link
}

const idle: Link = {
  phase: "idle",
  heard: false,
  waiting: false,
  framed: false,
}

export const detached: Links = { attached: false, A: idle, B: idle }

export type FeedStatus = "opened" | "closed" | "alive"

export type BrokerInput =
  | { readonly _tag: "attach" }
  | { readonly _tag: "detach" }
  | { readonly _tag: "tick" }
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
  draft.commands.push({
    _tag: "open",
    connection,
    url: draft.site.url(connection),
    subscribe: draft.site.subscribe,
  })
  draft.next[connection] = { ...idle, phase: "opening" }
})

// A link the tick must (re)open: an idle A; an idle B once A streams; or one
// whose open or ping went unanswered for a whole tick.
const isDue = Effect.fnUntraced(function* (
  draft: Draft,
  connection: Connection
) {
  const link = draft.links[connection]
  if (link.phase !== "idle") return link.waiting
  return (
    connection === "A" || (draft.next.A.phase === "open" && draft.next.A.framed)
  )
})

// At most one socket opens per tick, so A and B never open together and never
// drop together. A goes first; B opens for the first time only once A has
// streamed.
const onTick = Effect.fnUntraced(function* (draft: Draft) {
  if (!draft.links.attached) return
  let opened = false
  for (const connection of connections) {
    const link = draft.links[connection]
    if (link.heard) {
      draft.next[connection] = { ...link, heard: false, waiting: false }
    } else if (yield* isDue(draft, connection)) {
      if (opened) continue
      if (link.phase === "open")
        draft.statuses.push({ connection, status: "closed" })
      yield* open(draft, connection)
      opened = true
    } else if (link.phase !== "idle") {
      if (link.phase === "open")
        draft.commands.push({ _tag: "send", connection, text: draft.site.ping })
      draft.next[connection] = { ...link, waiting: true }
    }
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
  draft.next[connection] = idle
  // Decision: a socket that streamed reopens at once; one that closed before
  // its first frame waits for the next tick, so a broker refusing the relay
  // costs one attempt per 10 s rather than a tight loop.
  if (link.framed) yield* open(draft, connection)
})

const onDetach = Effect.fnUntraced(function* (draft: Draft) {
  for (const connection of connections)
    if (draft.links[connection].phase === "open")
      draft.statuses.push({ connection, status: "closed" })
  Object.assign(draft.next, detached)
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
      yield* open(draft, "A")
      break
    case "detach":
      yield* onDetach(draft)
      break
    case "opened":
      draft.next[input.connection] = { ...idle, phase: "open" }
      draft.statuses.push({ connection: input.connection, status: "opened" })
      break
    case "frame":
      yield* onFrame(draft, input.connection)
      break
    case "closed":
      yield* onClosed(draft, input.connection)
      break
    case "tick":
      yield* onTick(draft)
      break
  }
  return {
    links: draft.next,
    commands: draft.commands,
    statuses: draft.statuses,
  }
})
