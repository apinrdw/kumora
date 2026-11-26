import { assert, describe, it } from "@effect/vitest"
import type { IngestUp } from "@workspace/relay"
import { Effect } from "effect"

import { makeBatcher } from "../src/worker/batch.ts"
import {
  ajaib,
  ajaibOnDemand,
  type BrokerEvent,
  type PageEvent,
} from "../src/worker/broker.ts"
import { loadPageRequest, savePageRequest } from "../src/worker/settings.ts"
import { makeBrokerTab, type TabHooks } from "../src/worker/tab.ts"
import { memorySession } from "./memory-session.ts"

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

describe("a broker tab's page events", () => {
  it.effect(
    "the page's lock reports reach the worker, and a tab that goes is unlocked",
    () =>
      Effect.gen(function* () {
        const events: Array<PageEvent> = []
        const tab = yield* makeBrokerTab({
          feed: "Ajaib",
          sites: [ajaib, ...ajaibOnDemand],
          batcher: yield* makeBatcher(),
          publish: () => Effect.void,
          hooks,
          page: (pageEvent) => Effect.sync(() => events.push(pageEvent)),
        })
        yield* tab.connect(port)
        yield* tab.message(port, { _tag: "lock", locked: true })
        yield* tab.message(port, { _tag: "pin-validated", status: 403 })
        yield* tab.disconnect(port)
        assert.deepStrictEqual(events, [
          { _tag: "lock", locked: true },
          { _tag: "pin-validated", status: 403 },
          { _tag: "lock", locked: false },
        ])
      })
  )

  it.effect(
    "a waiting tab that takes over reports the lock it already showed",
    () =>
      Effect.gen(function* () {
        const events: Array<PageEvent> = []
        const tab = yield* makeBrokerTab({
          feed: "Ajaib",
          sites: [ajaib, ...ajaibOnDemand],
          batcher: yield* makeBatcher(),
          publish: () => Effect.void,
          hooks,
          page: (pageEvent) => Effect.sync(() => events.push(pageEvent)),
        })
        const second = { ...port }
        yield* tab.connect(port)
        yield* tab.connect(second)
        // The second tab's page reports its lock as its port connects.
        yield* tab.message(second, { _tag: "lock", locked: true })
        yield* tab.disconnect(port)
        assert.deepStrictEqual(events.at(-1), { _tag: "lock", locked: true })
      })
  )
})

describe("the Ajaib page's kept request", () => {
  const makeTab = Effect.gen(function* () {
    memorySession()
    return yield* makeBrokerTab({
      feed: "Ajaib",
      sites: [ajaib, ...ajaibOnDemand],
      batcher: yield* makeBatcher(),
      publish: () => Effect.void,
      hooks,
      pageRequests: { load: loadPageRequest, save: savePageRequest },
    })
  })
  // A port that records each command the worker posts to its tab.
  const recording = () => {
    const posted: Array<unknown> = []
    const recorder = {
      name: "Ajaib",
      postMessage: (command: unknown) => void posted.push(command),
    } as unknown as chrome.runtime.Port
    return { recorder, posted }
  }
  const BASE = "https://trade.ajaib.co.id/api/"

  it.effect(
    "a tab that loads after the page's call gets its static headers, never its token or device signature",
    () =>
      Effect.gen(function* () {
        const tab = yield* makeTab
        yield* tab.connect(port)
        yield* tab.message(port, {
          _tag: "page-request",
          base: BASE,
          headers: {
            Authorization: "jwt page-token",
            "X-Device-Signature": "page-signature",
            "X-Ht-Ver-Id": "4.2",
            Accept: "application/json",
          },
        })
        yield* tab.disconnect(port)
        const reloaded = recording()
        yield* tab.connect(reloaded.recorder)
        assert.deepStrictEqual(reloaded.posted.at(-1), {
          _tag: "kept-page-request",
          base: BASE,
          headers: { "X-Ht-Ver-Id": "4.2", Accept: "application/json" },
        })
        const stored = JSON.stringify(
          yield* Effect.promise(() => chrome.storage.session.get(null))
        )
        assert.notInclude(stored, "page-token")
        assert.notInclude(stored, "page-signature")
      })
  )

  it.effect("a header the page sends later replaces the kept one", () =>
    Effect.gen(function* () {
      const tab = yield* makeTab
      yield* tab.connect(port)
      for (const version of ["4.2", "4.3"])
        yield* tab.message(port, {
          _tag: "page-request",
          base: BASE,
          headers: { authorization: "jwt page-token", "x-ht-ver-id": version },
        })
      yield* tab.disconnect(port)
      const reloaded = recording()
      yield* tab.connect(reloaded.recorder)
      assert.deepStrictEqual(reloaded.posted.at(-1), {
        _tag: "kept-page-request",
        base: BASE,
        headers: { "x-ht-ver-id": "4.3" },
      })
    })
  )

  it.effect("a tab that loads before any page call is sent nothing", () =>
    Effect.gen(function* () {
      const tab = yield* makeTab
      const first = recording()
      yield* tab.connect(first.recorder)
      assert.notInclude(
        first.posted.map((command) => (command as { _tag: string })._tag),
        "kept-page-request"
      )
    })
  )
})
