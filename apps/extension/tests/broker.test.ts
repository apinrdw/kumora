import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  ajaib,
  detached,
  step,
  stockbit,
  type BrokerCommand,
  type BrokerSite,
  type BrokerInput,
  type Links,
  type Step,
} from "../src/worker/broker.ts"

// No tab yet, during streaming hours.
const duringHours: Links = { ...detached, window: "open" }

// Feeds inputs through the state machine and keeps everything it emitted.
const run = (
  inputs: ReadonlyArray<BrokerInput>,
  from: Links = duringHours,
  site: BrokerSite = ajaib
) =>
  Effect.gen(function* () {
    let links = from
    const steps: Array<Step> = []
    for (const input of inputs) {
      const next = yield* step(site, links, input)
      links = next.links
      steps.push(next)
    }
    return { links, steps }
  })

const opens = (result: Step | undefined) =>
  (result?.commands ?? [])
    .filter((command) => command._tag === "open")
    .map((command) => command.connection)

const sends = (result: Step | undefined) =>
  (result?.commands ?? []).filter(
    (command): command is Extract<BrokerCommand, { _tag: "send" }> =>
      command._tag === "send"
  )

const tick: BrokerInput = { _tag: "tick", window: "open" }
const frame = (connection: "A" | "B"): BrokerInput => ({
  _tag: "frame",
  site: "ajaib-trade",
  connection,
  payload: { text: '{"ticker":"BBCA"}' },
})
const opened = (connection: "A" | "B"): BrokerInput => ({
  _tag: "opened",
  site: "ajaib-trade",
  connection,
})
const closed = (connection: "A" | "B", code = 1006): BrokerInput => ({
  _tag: "closed",
  site: "ajaib-trade",
  connection,
  code,
})

// A attached, opened and streaming; B not yet open.
const streamingA: ReadonlyArray<BrokerInput> = [
  { _tag: "attach" },
  opened("A"),
  frame("A"),
]

describe("a broker site's connections", () => {
  it.effect(
    "attaching a tab opens A on Ajaib's trade stream with the TRADE subscribe",
    () =>
      Effect.gen(function* () {
        const { steps } = yield* run([{ _tag: "attach" }])
        assert.deepStrictEqual(steps[0]?.commands, [
          {
            _tag: "open",
            site: "ajaib-trade",
            connection: "A",
            url: "wss://stream.ajaib.co.id:8009/ws/trade",
            protocols: [],
            subscribe: [
              {
                text: '{"method":"SUBSCRIBE","stream":"TRADE","streamObject":"*"}',
              },
            ],
          },
        ])
      })
  )

  it.effect("B opens one tick after A's first frame, never before", () =>
    Effect.gen(function* () {
      const { steps } = yield* run([
        { _tag: "attach" },
        tick,
        opened("A"),
        tick,
        frame("A"),
        tick,
      ])
      assert.deepStrictEqual(opens(steps[1]), [])
      assert.deepStrictEqual(opens(steps[3]), [])
      assert.deepStrictEqual(opens(steps[5]), ["B"])
    })
  )

  it.effect("A and B never open in the same tick", () =>
    Effect.gen(function* () {
      // B opened on the tick after A's frame; then both went quiet. A's
      // unanswered ping reopens it first, and B follows a tick later.
      const { steps } = yield* run([...streamingA, tick, tick, tick, tick])
      assert.deepStrictEqual(opens(steps[3]), ["B"])
      assert.deepStrictEqual(opens(steps[5]), ["A"])
      assert.deepStrictEqual(opens(steps[6]), ["B"])
    })
  )

  it.effect(
    "a quiet tick sends PING-WEB, and a ping unanswered at the next tick reopens",
    () =>
      Effect.gen(function* () {
        const { steps } = yield* run([...streamingA, tick, tick, tick])
        // Tick 1 saw A's frame, so no ping; tick 2 found A quiet.
        assert.deepStrictEqual(sends(steps[3]), [])
        assert.deepStrictEqual(sends(steps[4]), [
          {
            _tag: "send",
            site: "ajaib-trade",
            connection: "A",
            payload: ajaib.ping,
          },
        ])
        assert.deepStrictEqual(opens(steps[5]), ["A"])
        assert.deepInclude(steps[5]?.statuses ?? [], {
          connection: "A",
          status: "closed",
        })
      })
  )

  it.effect("a ping reply is a sign of life and keeps the socket", () =>
    Effect.gen(function* () {
      const { steps } = yield* run([
        ...streamingA,
        tick,
        tick,
        frame("A"),
        tick,
      ])
      assert.deepStrictEqual(steps[5]?.statuses, [
        { connection: "A", status: "alive" },
      ])
      assert.notInclude(opens(steps[6]), "A")
    })
  )

  it.effect("a socket that streamed reopens at once on close", () =>
    Effect.gen(function* () {
      const { steps } = yield* run([...streamingA, closed("A")])
      assert.deepStrictEqual(opens(steps[3]), ["A"])
      assert.deepStrictEqual(steps[3]?.statuses, [
        { connection: "A", status: "closed" },
      ])
    })
  )

  it.effect(
    "a socket that closed before any frame reopens on the next tick",
    () =>
      Effect.gen(function* () {
        const { steps } = yield* run([
          { _tag: "attach" },
          opened("A"),
          closed("A"),
          tick,
        ])
        assert.deepStrictEqual(opens(steps[2]), [])
        assert.deepStrictEqual(opens(steps[3]), ["A"])
      })
  )

  it.effect("a socket stuck opening for a whole tick is opened again", () =>
    Effect.gen(function* () {
      const { steps } = yield* run([{ _tag: "attach" }, tick, tick])
      assert.deepStrictEqual(opens(steps[1]), [])
      assert.deepStrictEqual(opens(steps[2]), ["A"])
    })
  )

  it.effect(
    "detaching the tab reports its open sockets closed and stops ticking",
    () =>
      Effect.gen(function* () {
        const { steps } = yield* run([
          ...streamingA,
          tick,
          opened("B"),
          { _tag: "detach" },
          tick,
        ])
        assert.deepStrictEqual(steps[5]?.statuses, [
          { connection: "A", status: "closed" },
          { connection: "B", status: "closed" },
        ])
        assert.deepStrictEqual(steps[6]?.commands, [])
      })
  )

  it.effect(
    "before 08:40 nothing opens; the first tick in streaming hours opens A",
    () =>
      Effect.gen(function* () {
        const { steps } = yield* run(
          [
            { _tag: "attach" },
            { _tag: "tick", window: "closed" },
            { _tag: "tick", window: "open" },
          ],
          detached
        )
        assert.deepStrictEqual(opens(steps[0]), [])
        assert.deepStrictEqual(opens(steps[1]), [])
        assert.deepStrictEqual(opens(steps[2]), ["A"])
      })
  )

  it.effect("at 16:35 every socket closes and nothing reopens", () =>
    Effect.gen(function* () {
      const closing: BrokerInput = { _tag: "tick", window: "closed" }
      const { steps } = yield* run([
        ...streamingA,
        tick,
        opened("B"),
        closing,
        closing,
      ])
      assert.deepStrictEqual(
        steps[5]?.commands.map((command) => command._tag),
        ["close", "close"]
      )
      assert.deepStrictEqual(steps[5]?.statuses, [
        { connection: "A", status: "closed" },
        { connection: "B", status: "closed" },
      ])
      assert.deepStrictEqual(steps[6]?.commands, [])
    })
  )

  it.effect(
    "during an auction a dropped socket reconnects, but none opens fresh",
    () =>
      Effect.gen(function* () {
        const auction: BrokerInput = { _tag: "tick", window: "auction" }
        // A streamed before the auction; B never opened.
        const { steps } = yield* run([...streamingA, auction, closed("A")])
        assert.deepStrictEqual(opens(steps[3]), [])
        assert.deepStrictEqual(opens(steps[4]), ["A"])

        // A tab attached mid-auction waits for the auction to end.
        const late = yield* run([{ _tag: "attach" }, auction, auction, tick], {
          ...detached,
          window: "auction",
        })
        assert.deepStrictEqual(late.steps.map(opens), [[], [], [], ["A"]])
      })
  )

  it.effect("a socket dropped by the relay reopens on the next tick", () =>
    Effect.gen(function* () {
      const { steps } = yield* run([
        ...streamingA,
        { _tag: "drop", site: "ajaib-trade", connection: "A" },
        tick,
      ])
      assert.deepStrictEqual(
        steps[3]?.commands.map((command) => command._tag),
        ["close"]
      )
      assert.deepStrictEqual(steps[3]?.statuses, [
        { connection: "A", status: "closed" },
      ])
      assert.deepStrictEqual(opens(steps[4]), ["A"])
    })
  )

  it.effect(
    "Stockbit opens with the web subprotocol and pings in protobuf",
    () =>
      Effect.gen(function* () {
        const { steps } = yield* run(
          [
            { _tag: "attach" },
            { _tag: "opened", site: "stockbit", connection: "A" },
            tick,
          ],
          duringHours,
          stockbit
        )
        assert.deepInclude(steps[0]?.commands ?? [], {
          _tag: "open",
          site: "stockbit",
          connection: "A",
          url: "wss://wss-jkt.trading.stockbit.com/ws",
          protocols: ["web"],
          subscribe: [],
        })
        // WebsocketRequest { ping: { message: "ping" } }
        assert.deepStrictEqual(sends(steps[2]), [
          {
            _tag: "send",
            site: "stockbit",
            connection: "A",
            payload: { base64: btoa("\x22\x06\x0a\x04ping") },
          },
        ])
      })
  )
})
