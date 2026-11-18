import {
  StockCode,
  TradeNumber,
  WibDate,
  type SweepAlert,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { expect, test } from "vitest"

import {
  makeSweepAlertPlayer,
  type SoundSink,
} from "@/components/market-live/sweep-alert-player"

const alertOf = (side: SweepAlert["side"], seq: number): SweepAlert => ({
  code: StockCode.make("BBCA"),
  side,
  lots: 30,
  tradeNumbers: [TradeNumber.make(String(seq))],
})

const deltaOf = (sweepAlerts: ReadonlyArray<SweepAlert>): ViewerDown => ({
  _tag: "Delta",
  at: DateTime.makeUnsafe(0),
  tape: [],
  candles: [],
  sweepAlerts,
})

// A player over a sink that writes down each sound it is asked for: the live
// page's with sound on, unless told otherwise.
const playerOf = ({
  day,
  soundOn = true,
}: { day?: WibDate; soundOn?: boolean } = {}) => {
  const played: Array<SweepAlert["side"]> = []
  const sink: SoundSink = {
    play: (side) => Effect.sync(() => void played.push(side)),
  }
  const player = Effect.runSync(
    makeSweepAlertPlayer({ sink, day, soundOn: Effect.succeed(soundOn) })
  )
  const hear = (message: ViewerDown) => Effect.runSync(player.hear(message))
  return { hear, played }
}

test("an update with several buy alerts plays one buy sound", () => {
  const { hear, played } = playerOf()
  hear(deltaOf([alertOf("buy", 1), alertOf("buy", 2), alertOf("buy", 3)]))
  expect(played).toEqual(["buy"])
})

test("a buy and a sell in one update play together, one each", () => {
  const { hear, played } = playerOf()
  hear(
    deltaOf([
      alertOf("sell", 1),
      alertOf("buy", 2),
      alertOf("sell", 3),
      alertOf("buy", 4),
    ])
  )
  expect([...played].sort()).toEqual(["buy", "sell"])
})

test("each update plays its own: a later update's buy plays again", () => {
  const { hear, played } = playerOf()
  hear(deltaOf([alertOf("buy", 1)]))
  hear(deltaOf([]))
  hear(deltaOf([alertOf("buy", 2)]))
  expect(played).toEqual(["buy", "buy"])
})

test("a snapshot's alerts never play", () => {
  const { hear, played } = playerOf()
  // A snapshot carries the alerts of the trades its tape holds.
  const snapshot = {
    _tag: "Snapshot",
    at: DateTime.makeUnsafe(0),
    selected: StockCode.make("BBCA"),
    tape: [],
    candles: [],
    footprints: [],
    conditions: {
      phase: "session-1",
      relayOnline: true,
      feeds: {
        Stockbit: "live",
        Ajaib: "live",
      },
      gaps: [],
    },
    sweepAlerts: [alertOf("buy", 1), alertOf("sell", 2)],
  } as const
  hear(snapshot)
  expect(played).toEqual([])
})

test("nothing plays on a recorded day", () => {
  const { hear, played } = playerOf({ day: WibDate.make("2026-11-09") })
  hear(deltaOf([alertOf("buy", 1), alertOf("sell", 2)]))
  expect(played).toEqual([])
})

test("nothing plays while the speaker toggle is off", () => {
  const { hear, played } = playerOf({ soundOn: false })
  hear(deltaOf([alertOf("buy", 1), alertOf("sell", 2)]))
  expect(played).toEqual([])
})
