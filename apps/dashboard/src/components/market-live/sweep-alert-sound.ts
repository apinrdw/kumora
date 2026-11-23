import { Effect } from "effect"

import type { SoundSink } from "./sweep-alert-player"

// Pair B of the sound prototype (apinrdw/kumora#503, PAIRS[1] on
// branch prototype/sweep-alert-sounds): a triangle-wave major third, up for
// a buy and down for a sell. The two stay apart when they overlap. The volume
// is fixed: no slider.
//
// apps/e2e/tests/market-live-sweep-alerts.spec.ts repeats the buy's first
// note (`BUY_FIRST_NOTE`).
const NOTES = {
  buy: [
    { hz: 1047, seconds: 0.07 },
    { hz: 1319, seconds: 0.09 },
  ],
  sell: [
    { hz: 659, seconds: 0.07 },
    { hz: 523, seconds: 0.09 },
  ],
} as const
const PEAK = 0.35
const ATTACK = 0.005
// An exponential ramp can't reach 0: this is silence.
const SILENT = 0.0001

// The page's one AudioContext, made on first use. Without WebAudio it fails,
// and nothing plays.
let context: AudioContext | undefined
const audioContext = Effect.try(() => (context ??= new AudioContext()))

// Resumed when the browser suspended it. A browser lets audio start only
// after the page has had a click or key press, so the Speaker toggle's click
// wakes it.
const resume = (audio: AudioContext) =>
  audio.state === "suspended"
    ? Effect.tryPromise(() => audio.resume()).pipe(Effect.ignore)
    : Effect.void

export const wakeSound = audioContext.pipe(
  Effect.flatMap(resume),
  Effect.ignore
)

// One note from `at`: a short exponential attack to the peak, then an
// exponential decay to silence over the rest of the note.
const note = (
  audio: AudioContext,
  at: number,
  { hz, seconds }: { hz: number; seconds: number }
) =>
  Effect.sync(() => {
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()
    oscillator.type = "triangle"
    oscillator.frequency.setValueAtTime(hz, at)
    gain.gain.setValueAtTime(SILENT, at)
    gain.gain.exponentialRampToValueAtTime(PEAK, at + ATTACK)
    gain.gain.exponentialRampToValueAtTime(SILENT, at + seconds)
    oscillator.connect(gain).connect(audio.destination)
    oscillator.start(at)
    oscillator.stop(at + seconds + 0.02)
  })

// The page's sound sink. A buy and a sell asked for in the same delta
// start at the same moment: the context's clock stands still while one
// script runs, and nothing here waits. A context that isn't running drops
// the sound: notes scheduled in a suspended one would all play at once when
// a click resumes it, and a sound means "just now" (spec apinrdw/kumora#510,
// story 12).
export const sweepAlertSound: SoundSink = {
  play: (side) =>
    Effect.gen(function* () {
      const audio = yield* audioContext
      if (audio.state !== "running") {
        yield* Effect.forkDetach(resume(audio))
        return
      }
      let at = audio.currentTime + 0.01
      for (const played of NOTES[side]) {
        yield* note(audio, at, played)
        at += played.seconds
      }
    }).pipe(Effect.ignore),
}
