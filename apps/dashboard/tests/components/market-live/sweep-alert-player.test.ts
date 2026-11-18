import {
  StockCode,
  TradeNumber,
  WibDate,
  type AlertSide,
  type SweepAlert,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { expect, test } from "vitest"

import {
  makePlayingTab,
  type OpenTabChannel,
  type TabMessage,
} from "@/components/market-live/playing-tab"
import {
  makeSweepAlertPlayer,
  type SoundSink,
} from "@/components/market-live/sweep-alert-player"

const alertOf = (side: AlertSide, seq: number): SweepAlert => ({
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
  const played: Array<AlertSide> = []
  const sink: SoundSink = {
    play: (side) => Effect.sync(() => void played.push(side)),
  }
  const player = Effect.runSync(
    makeSweepAlertPlayer({
      sink,
      day,
      soundOn: Effect.succeed(soundOn),
      mayPlay: Effect.succeed(true),
    })
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

// One browser's BroadcastChannel: a message reaches every other open member.
const channelOf = (): OpenTabChannel => {
  const members = new Set<(message: TabMessage) => void>()
  return (receive) =>
    Effect.sync(() => {
      members.add(receive)
      return {
        post: (message) => {
          for (const member of members) if (member !== receive) member(message)
        },
        close: () => void members.delete(receive),
      }
    })
}

// A Market Live tab on `channel`: its player plays only while the tab holds
// the role. It joins the channel as it opens, focused or not.
const tabOf = (channel: OpenTabChannel, { focused }: { focused: boolean }) => {
  const played: Array<AlertSide> = []
  const sink: SoundSink = {
    play: (side) => Effect.sync(() => void played.push(side)),
  }
  const tab = Effect.runSync(makePlayingTab(channel))
  const player = Effect.runSync(
    makeSweepAlertPlayer({
      sink,
      day: undefined,
      soundOn: Effect.succeed(true),
      mayPlay: tab.holds,
    })
  )
  Effect.runSync(tab.join(focused))
  return {
    played,
    hear: (message: ViewerDown) => Effect.runSync(player.hear(message)),
    focus: () => Effect.runSync(tab.focus),
    leave: () => Effect.runSync(tab.leave),
    rejoin: (back: { focused: boolean }) =>
      Effect.runSync(tab.join(back.focused)),
  }
}

// Each tab hears the same delta, as every open tab's socket does.
const heardBy = (
  tabs: ReadonlyArray<{ hear: (message: ViewerDown) => void }>,
  message: ViewerDown
) => {
  for (const tab of tabs) tab.hear(message)
}

test("of two open tabs, only the one focused last plays", () => {
  const channel = channelOf()
  const first = tabOf(channel, { focused: true })
  const second = tabOf(channel, { focused: true })
  heardBy([first, second], deltaOf([alertOf("buy", 1)]))
  expect(first.played).toEqual([])
  expect(second.played).toEqual(["buy"])
})

test("focusing the other tab moves the role to it", () => {
  const channel = channelOf()
  const first = tabOf(channel, { focused: true })
  const second = tabOf(channel, { focused: true })
  first.focus()
  heardBy([first, second], deltaOf([alertOf("sell", 1)]))
  second.focus()
  heardBy([first, second], deltaOf([alertOf("buy", 2)]))
  expect(first.played).toEqual(["sell"])
  expect(second.played).toEqual(["buy"])
})

test("when the playing tab closes, the other open tab takes over", () => {
  const channel = channelOf()
  const first = tabOf(channel, { focused: true })
  const second = tabOf(channel, { focused: true })
  second.leave()
  heardBy([first], deltaOf([alertOf("buy", 1)]))
  expect(first.played).toEqual(["buy"])
})

test("a tab alone plays, focused or not", () => {
  const tab = tabOf(channelOf(), { focused: false })
  tab.hear(deltaOf([alertOf("buy", 1)]))
  expect(tab.played).toEqual(["buy"])
})

test("a tab opening in the background leaves the role where it is", () => {
  const channel = channelOf()
  const first = tabOf(channel, { focused: false })
  const second = tabOf(channel, { focused: false })
  heardBy([first, second], deltaOf([alertOf("buy", 1)]))
  expect(first.played).toEqual(["buy"])
  expect(second.played).toEqual([])
})

test("a tab coming back after it went away rejoins without the role", () => {
  const channel = channelOf()
  const first = tabOf(channel, { focused: true })
  const second = tabOf(channel, { focused: true })
  // The playing tab goes into the back-forward cache, then comes back unseen.
  second.leave()
  second.rejoin({ focused: false })
  heardBy([first, second], deltaOf([alertOf("buy", 1)]))
  expect(first.played).toEqual(["buy"])
  expect(second.played).toEqual([])
})

test("nothing plays while the speaker toggle is off", () => {
  const { hear, played } = playerOf({ soundOn: false })
  hear(deltaOf([alertOf("buy", 1), alertOf("sell", 2)]))
  expect(played).toEqual([])
})
