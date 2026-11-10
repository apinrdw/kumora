import { assert, describe, it } from "@effect/vitest"
import type { IngestUp } from "@workspace/relay"
import { Effect } from "effect"

import { makeBatcher } from "../src/worker/batch.ts"
import { ajaib, ajaibOnDemand, type BrokerEvent } from "../src/worker/broker.ts"
import { makeBrokerTab, type TabHooks } from "../src/worker/tab.ts"

const hooks: TabHooks = {
  opened: () => Effect.void,
  closed: () => Effect.void,
}

const port = {
  name: "Ajaib",
  postMessage: () => {},
} as unknown as chrome.runtime.Port

const event = (raw: BrokerEvent) => raw

// What the dashboard would see of each envelope's order: the feed status, or
// the frames' stream and connection.
const seen = (message: IngestUp) =>
  message._tag === "FeedStatus"
    ? `${message.status} ${message.connection}`
    : message._tag === "Frames" && message.feed === "Ajaib"
      ? `${message.stream} frames ${message.connection}`
      : message._tag

describe("a broker tab's envelopes", () => {
  it.effect(
    "a connection's buffered frames go up before its close, as the periodic flush would have sent them",
    () =>
      Effect.gen(function* () {
        const published: Array<IngestUp> = []
        const batcher = yield* makeBatcher()
        const tab = yield* makeBrokerTab({
          feed: "Ajaib",
          sites: [ajaib, ...ajaibOnDemand],
          batcher,
          publish: (message) => Effect.sync(() => published.push(message)),
          hooks,
        })
        yield* tab.connect(port)
        const trade = { site: "ajaib-trade", connection: "A" } as const
        yield* tab.message(port, event({ _tag: "opened", ...trade }))
        yield* tab.message(
          port,
          event({ _tag: "frame", ...trade, payload: { text: '{"t":1}' } })
        )
        yield* tab.message(
          port,
          event({ _tag: "closed", ...trade, code: 1006 })
        )
        yield* Effect.forEach(yield* batcher.flush, (message) =>
          Effect.sync(() => published.push(message))
        )
        assert.deepStrictEqual(published.map(seen), [
          "opened A",
          "trade frames A",
          "closed A",
        ])
      })
  )

  it.effect(
    "the tab going away closes its open connections after their frames",
    () =>
      Effect.gen(function* () {
        const published: Array<IngestUp> = []
        const batcher = yield* makeBatcher()
        const tab = yield* makeBrokerTab({
          feed: "Ajaib",
          sites: [ajaib, ...ajaibOnDemand],
          batcher,
          publish: (message) => Effect.sync(() => published.push(message)),
          hooks,
        })
        yield* tab.connect(port)
        const trade = { site: "ajaib-trade", connection: "B" } as const
        yield* tab.message(port, event({ _tag: "opened", ...trade }))
        yield* tab.message(
          port,
          event({ _tag: "frame", ...trade, payload: { text: '{"t":1}' } })
        )
        yield* tab.disconnect(port)
        yield* Effect.forEach(yield* batcher.flush, (message) =>
          Effect.sync(() => published.push(message))
        )
        assert.deepStrictEqual(published.map(seen), [
          "opened B",
          "trade frames B",
          "closed B",
        ])
      })
  )
})
