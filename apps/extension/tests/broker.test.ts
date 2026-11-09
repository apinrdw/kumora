import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  ajaib,
  detached,
  step,
  type BrokerCommand,
  type BrokerInput,
  type Links,
  type Step,
} from "../src/worker/broker.ts"

// Feeds inputs through the state machine and keeps everything it emitted.
const run = (inputs: ReadonlyArray<BrokerInput>, from: Links = detached) =>
  Effect.gen(function* () {
    let links = from
    const steps: Array<Step> = []
    for (const input of inputs) {
      const next = yield* step(ajaib, links, input)
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

const tick: BrokerInput = { _tag: "tick" }
const frame = (connection: "A" | "B"): BrokerInput => ({
  _tag: "frame",
  connection,
  text: '{"ticker":"BBCA"}',
})

// A attached, opened and streaming; B not yet open.
const streamingA: ReadonlyArray<BrokerInput> = [
  { _tag: "attach" },
  { _tag: "opened", connection: "A" },
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
            connection: "A",
            url: "wss://stream.ajaib.co.id:8009/ws/trade",
            subscribe: [
              '{"method":"SUBSCRIBE","stream":"TRADE","streamObject":"*"}',
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
        { _tag: "opened", connection: "A" },
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
          { _tag: "send", connection: "A", text: ajaib.ping },
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
      const { steps } = yield* run([
        ...streamingA,
        { _tag: "closed", connection: "A", code: 1006 },
      ])
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
          { _tag: "opened", connection: "A" },
          { _tag: "closed", connection: "A", code: 1006 },
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
          { _tag: "opened", connection: "B" },
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
})
