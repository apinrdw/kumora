import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Deferred, Effect, Option } from "effect"
import type { IngestDown } from "@workspace/relay"

import type { AjaibAccountId } from "../src/worker/ajaib.ts"
import type { Payload } from "../src/worker/broker.ts"
import { makeOnDemandCodes } from "../src/worker/on-demand-codes.ts"
import {
  makeAjaibSubscriptions,
  type OnDemandSubscriptions,
} from "../src/worker/subscriptions.ts"
import type { BrokerTab } from "../src/worker/tab.ts"

// An Ajaib tab with every socket open, keeping what is sent on each.
const openTab = () => {
  const sent: Array<{ site: string; connection: string; payload: Payload }> = []
  const tab: BrokerTab = {
    connect: () => Effect.void,
    message: () => Effect.void,
    disconnect: () => Effect.void,
    tick: () => Effect.void,
    request: () => Effect.succeed(Option.none()),
    send: (site, connection, payload) =>
      Effect.sync(() => void sent.push({ site, connection, payload })),
    drop: () => Effect.void,
    isOpen: () => Effect.succeed(true),
    attached: Effect.succeed(true),
  }
  return { tab, sent }
}

describe("Ajaib's on-demand subscriptions", () => {
  it.effect(
    "a resubscribe returns while the account id is still being asked for, and subscribes once it is answered",
    () =>
      Effect.gen(function* () {
        const { tab, sent } = openTab()
        // The tab's answer, which queues behind the event a resubscribe runs
        // in: it must not wait for it.
        const accountId = yield* Deferred.make<Option.Option<AjaibAccountId>>()
        const subscriptions = yield* makeAjaibSubscriptions(
          Effect.succeed([StockCode.make("BBCA")]),
          Deferred.await(accountId)
        )
        const resubscribe = yield* Effect.forkChild(
          subscriptions.resubscribe(tab, [])
        )
        yield* Effect.yieldNow
        assert.isDefined(resubscribe.pollUnsafe())
        assert.lengthOf(sent, 0)

        yield* Deferred.succeed(accountId, Option.none())
        yield* Effect.yieldNow
        assert.deepStrictEqual(
          sent.map(({ site, connection }) => `${site}/${connection}`).sort(),
          [
            "ajaib-indicative/A",
            "ajaib-indicative/B",
            "ajaib-order-book/A",
            "ajaib-order-book/B",
            "ajaib-price/A",
            "ajaib-price/B",
          ]
        )
        assert.deepStrictEqual(sent[0]!.payload, {
          text: JSON.stringify({
            method: "SUBSCRIBE",
            stream: "PRICE",
            streamObject: "BBCA",
          }),
        })
      }).pipe(Effect.scoped)
  )
})

const BBCA = StockCode.make("BBCA")
const asks = (codes: ReadonlyArray<StockCode>): IngestDown => ({
  _tag: "OnDemandCodes",
  codes,
})

// The methods sent on one socket, in order.
const methodsOn = (
  sent: ReadonlyArray<{ site: string; connection: string; payload: Payload }>,
  site: string,
  connection: string
) =>
  sent
    .filter((entry) => entry.site === site && entry.connection === connection)
    .map(({ payload }) => {
      const { method, streamObject } = JSON.parse(
        "text" in payload ? payload.text : "{}"
      ) as { method: string; streamObject: string }
      return `${method} ${streamObject}`
    })

// The on-demand codes wired to the subscriptions as the service worker wires
// them, with every Ajaib socket open and the account id known.
const relay = Effect.gen(function* () {
  const { tab, sent } = openTab()
  const subscriptions: OnDemandSubscriptions = yield* makeAjaibSubscriptions(
    Effect.suspend(() => onDemandCodes.codes),
    Effect.succeed(Option.none())
  )
  const onDemandCodes = yield* makeOnDemandCodes({
    changed: (fresh) => subscriptions.resubscribe(tab, fresh),
    backfill: () => Effect.void,
  })
  return { sent, receive: onDemandCodes.receive }
})

describe("a target's Ajaib books", () => {
  it.effect(
    "start whole: a code a target newly asks for while the other target holds it is unsubscribed and subscribed again",
    () =>
      Effect.gen(function* () {
        const { sent, receive } = yield* relay
        yield* receive("production", asks([BBCA]))
        yield* Effect.yieldNow
        assert.deepStrictEqual(methodsOn(sent, "ajaib-order-book", "A"), [
          "SUBSCRIBE BBCA",
        ])
        sent.length = 0

        yield* receive("extra", asks([BBCA]))
        yield* Effect.yieldNow
        assert.deepStrictEqual(methodsOn(sent, "ajaib-order-book", "A"), [
          "UNSUBSCRIBE BBCA",
          "SUBSCRIBE BBCA",
        ])
        assert.lengthOf(sent, 12)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "start whole again after the target's socket reconnects, as its deltas meanwhile were dropped",
    () =>
      Effect.gen(function* () {
        const { sent, receive } = yield* relay
        yield* receive("production", asks([BBCA]))
        yield* receive("extra", asks([BBCA]))
        yield* Effect.yieldNow
        sent.length = 0

        yield* receive("production", undefined)
        yield* receive("production", asks([BBCA]))
        yield* Effect.yieldNow
        assert.deepStrictEqual(methodsOn(sent, "ajaib-order-book", "B"), [
          "UNSUBSCRIBE BBCA",
          "SUBSCRIBE BBCA",
        ])
      }).pipe(Effect.scoped)
  )
})
