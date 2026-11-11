// What each open broker socket is subscribed to, kept current as the code
// list and the on-demand set change (spec apinrdw/kumora#138, "Broker
// connections").
import type { Connection, StockCode } from "@workspace/relay"
import { Effect, FiberMap, Option, type Scope } from "effect"
import * as Base64 from "effect/encoding/Base64"

import {
  onDemandMessages,
  tradeSubscribe,
  type AjaibAccountId,
  type OnDemandStream,
} from "./ajaib.ts"
import type { SiteName } from "./broker.ts"
import {
  WEBSOCKET_KEY_URL,
  subscribeFrame,
  tabCredential,
  websocketKey,
  type StockbitCredential,
} from "./stockbit.ts"
import type { BrokerTab, TabHooks } from "./tab.ts"

const connections: ReadonlyArray<Connection> = ["A", "B"]

// A tab's subscription keeper: its socket hooks, and a resend after a change.
export interface Subscriptions {
  readonly hooks: TabHooks
  readonly resubscribe: (tab: BrokerTab) => Effect.Effect<void>
}

// Ajaib's on-demand keeper: a resend names the codes a target newly asked
// for, `fresh`, which a socket already holding them subscribes afresh.
export interface OnDemandSubscriptions {
  readonly hooks: TabHooks
  readonly resubscribe: (
    tab: BrokerTab,
    fresh: ReadonlyArray<StockCode>
  ) => Effect.Effect<void>
}

// Stockbit: on each open, a fresh websocket key with the tab's token, then
// one channel message with every listed code. A changed list resends it in
// full on every open socket.
export const makeStockbitSubscriptions = Effect.fnUntraced(function* (
  codes: Effect.Effect<ReadonlyArray<StockCode>>
): Effect.fn.Return<Subscriptions, never, Scope.Scope> {
  const fibers = yield* FiberMap.make<Connection>()
  const sessions = new Map<
    Connection,
    { readonly credential: StockbitCredential; readonly key: string }
  >()

  const subscribe = Effect.fnUntraced(function* (
    tab: BrokerTab,
    connection: Connection
  ) {
    const session = sessions.get(connection)
    if (session === undefined) return
    const frame = yield* subscribeFrame({ ...session, codes: yield* codes })
    yield* tab.send("stockbit", connection, { base64: Base64.encode(frame) })
  })

  const authenticate = Effect.fnUntraced(function* (
    tab: BrokerTab,
    connection: Connection
  ) {
    const credential = yield* tabCredential(tab)
    if (Option.isNone(credential))
      return yield* Effect.logWarning("Stockbit tab has no access token")
    const answer = yield* tab.request({
      _tag: "fetch",
      url: WEBSOCKET_KEY_URL,
      headers: { authorization: `Bearer ${credential.value.accessToken}` },
    })
    const key =
      Option.isSome(answer) && answer.value.status === 200
        ? yield* websocketKey(answer.value.body)
        : Option.none()
    if (Option.isNone(key))
      return yield* Effect.logWarning("Stockbit websocket key fetch failed")
    sessions.set(connection, { credential: credential.value, key: key.value })
    yield* subscribe(tab, connection)
  })

  const hooks: TabHooks = {
    opened: (tab, _site, connection) =>
      FiberMap.run(
        fibers,
        connection,
        // A socket with no key is useless: drop it, and the next tick
        // reopens it.
        Effect.flatMap(authenticate(tab, connection), () =>
          sessions.has(connection)
            ? Effect.void
            : tab.drop("stockbit", connection)
        )
      ).pipe(Effect.asVoid),
    closed: (_tab, _site, connection) =>
      Effect.suspend(() => {
        sessions.delete(connection)
        return FiberMap.remove(fibers, connection)
      }),
  }

  const resubscribe = (tab: BrokerTab) =>
    Effect.forEach(connections, (connection) => subscribe(tab, connection), {
      discard: true,
    })
  return { hooks, resubscribe }
})

const streams: Readonly<Partial<Record<SiteName, OnDemandStream>>> = {
  "ajaib-price": "PRICE",
  "ajaib-indicative": "INDICATIVE",
  "ajaib-order-book": "ORDER_BOOK_CUSTOM",
}

// Ajaib's sockets: the trade socket subscribes the whole tape as it opens;
// each on-demand socket holds the codes it subscribed, and a change sends
// only the difference, plus the pair that starts a fresh code's book again.
// Every frame carries the account id `accountId` gives, once there is one.
export const makeAjaibSubscriptions = Effect.fnUntraced(function* (
  wanted: Effect.Effect<ReadonlyArray<StockCode>>,
  accountId: Effect.Effect<Option.Option<AjaibAccountId>>
): Effect.fn.Return<OnDemandSubscriptions, never, Scope.Scope> {
  const held = new Map<string, ReadonlyArray<StockCode>>()
  // Decision: the fresh codes wait per socket until its subscribe sends,
  // not in the subscribe's arguments: a subscribe still asking the tab for
  // the account id is replaced by the next, which would drop them, and a
  // target's whole book would never come. A closed socket forgets them; its
  // reopen subscribes every code from nothing.
  const fresh = new Map<string, Set<StockCode>>()
  // Reading the id asks the tab, whose answer queues behind the event a hook
  // or a resubscribe runs in, so each socket's subscribe runs in a fiber of
  // its own, keyed by the socket: a later one replaces one still asking.
  const fibers = yield* FiberMap.make<string>()
  const keyOf = (site: SiteName, connection: Connection) =>
    Effect.succeed(`${site}/${connection}`)

  const update = Effect.fnUntraced(function* (
    tab: BrokerTab,
    site: SiteName,
    connection: Connection
  ) {
    const stream = streams[site]
    const key = yield* keyOf(site, connection)
    if (stream === undefined || !(yield* tab.isOpen(site, connection))) {
      fresh.delete(key)
      return
    }
    const id = yield* accountId
    const to = yield* wanted
    // From here to the last send nothing waits, and a replacing update can't
    // interrupt, so two updates never send the same difference and a socket
    // never holds half of one.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const messages = yield* onDemandMessages(
          stream,
          held.get(key) ?? [],
          to,
          [...(fresh.get(key) ?? [])],
          id
        )
        held.set(key, to)
        fresh.delete(key)
        for (const payload of messages)
          yield* tab.send(site, connection, payload)
      })
    )
  })

  const opened = Effect.fnUntraced(function* (
    tab: BrokerTab,
    site: SiteName,
    connection: Connection
  ) {
    if (site === "ajaib-trade")
      return yield* tab.send(
        site,
        connection,
        yield* tradeSubscribe(yield* accountId)
      )
    yield* update(tab, site, connection)
  })

  const hooks: TabHooks = {
    opened: Effect.fnUntraced(function* (
      tab: BrokerTab,
      site: SiteName,
      connection: Connection
    ) {
      yield* FiberMap.run(
        fibers,
        yield* keyOf(site, connection),
        opened(tab, site, connection)
      )
    }),
    closed: Effect.fnUntraced(function* (
      _tab: BrokerTab,
      site: SiteName,
      connection: Connection
    ) {
      const key = yield* keyOf(site, connection)
      held.delete(key)
      fresh.delete(key)
      yield* FiberMap.remove(fibers, key)
    }),
  }

  const resubscribe = (tab: BrokerTab, codes: ReadonlyArray<StockCode>) =>
    Effect.forEach(
      Object.keys(streams) as ReadonlyArray<SiteName>,
      (site) =>
        Effect.forEach(
          connections,
          (connection) =>
            Effect.flatMap(keyOf(site, connection), (key) => {
              const waiting = fresh.get(key) ?? new Set()
              for (const code of codes) waiting.add(code)
              fresh.set(key, waiting)
              return FiberMap.run(fibers, key, update(tab, site, connection))
            }),
          { discard: true }
        ),
      { discard: true }
    )
  return { hooks, resubscribe }
})
