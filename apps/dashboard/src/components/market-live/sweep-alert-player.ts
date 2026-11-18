import type { SweepAlert, ViewerDown, WibDate } from "@workspace/relay"
import { Effect } from "effect"
import { useState } from "react"

import { usePlayingTab } from "./playing-tab"
import { soundOn as speakerOn } from "./sound-toggle"
import { sweepAlertSound } from "./sweep-alert-sound"

type Side = SweepAlert["side"]

// Where the player's sounds go: the WebAudio synth on the page
// (sweep-alert-sound.ts), a fake that writes them down in tests.
export type SoundSink = {
  readonly play: (side: Side) => Effect.Effect<void>
}

// Plays each live delta's Sweep alerts through `sink`: at most one buy and
// one sell per delta, both at once, the rest dropped rather than queued. A
// snapshot's alerts are history (a reload or reconnect) and never play.
export const makeSweepAlertPlayer = ({
  sink,
  day,
  soundOn,
  mayPlay,
}: {
  sink: SoundSink
  // The page's recorded day, or undefined on the live page.
  day: WibDate | undefined
  // The speaker toggle, read at each delta.
  soundOn: Effect.Effect<boolean>
  // Whether this tab holds the role of playing (playing-tab.ts), read at each
  // delta.
  mayPlay: Effect.Effect<boolean>
}) =>
  Effect.sync(() => ({
    hear: Effect.fnUntraced(function* (message: ViewerDown) {
      if (message._tag !== "Delta" || message.sweepAlerts === undefined) return
      if (day !== undefined || !(yield* soundOn) || !(yield* mayPlay)) return
      const sides = new Set(message.sweepAlerts.map(({ side }) => side))
      for (const side of sides) yield* sink.play(side)
    }),
  }))

// The page's player: the WebAudio synth behind the speaker toggle, playing
// while this tab holds the role.
export const useSweepAlertPlayer = (day: WibDate | undefined) => {
  const tab = usePlayingTab(day)
  const [player] = useState(() =>
    Effect.runSync(
      makeSweepAlertPlayer({
        sink: sweepAlertSound,
        day,
        soundOn: speakerOn,
        mayPlay: tab.holds,
      })
    )
  )
  return player
}
