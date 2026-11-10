import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Deferred, Effect, Option } from "effect"

import type { AjaibAccountId } from "../src/worker/ajaib.ts"
import type { Payload } from "../src/worker/broker.ts"
import { makeAjaibSubscriptions } from "../src/worker/subscriptions.ts"
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
          subscriptions.resubscribe(tab)
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
