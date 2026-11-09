import { useSyncExternalStore } from "react"

import {
  advance,
  minuteEnd,
  playFrom,
  type ReplayDay,
  type Speed,
} from "@/lib/replay"

export type ReplayState = {
  readonly at: number
  readonly playing: boolean
  readonly speed: Speed
}

export interface ReplayCursor {
  readonly day: ReplayDay
  readonly state: () => ReplayState
  readonly subscribe: (listener: () => void) => () => void
  readonly toggle: () => void
  readonly pause: () => void
  // Moves the cursor, held inside the day; Play carries on from there.
  readonly seek: (at: number) => void
  readonly setSpeed: (speed: Speed) => void
  // A candle click: pause at the end of that candle's minute.
  readonly pickMinute: (minute: number) => void
  // Stops Play's animation frames for good.
  readonly dispose: () => void
}

// A recorded day's replay cursor, outside React: it opens paused at the
// close, and Play moves it once an animation frame by the real time elapsed.
export function makeReplayCursor(day: ReplayDay): ReplayCursor {
  let state: ReplayState = { at: day.close, playing: false, speed: 1 }
  let frame = 0
  let last = 0
  const listeners = new Set<() => void>()
  const set = (next: Partial<ReplayState>) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  const tick = (now: number) => {
    const moved = advance(day, state.at, now - last, state.speed)
    last = now
    frame = moved.ended ? 0 : requestAnimationFrame(tick)
    set({ at: moved.at, playing: !moved.ended })
  }
  const pause = () => {
    cancelAnimationFrame(frame)
    frame = 0
    if (state.playing) set({ playing: false })
  }
  return {
    day,
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    toggle: () => {
      if (state.playing) return pause()
      last = performance.now()
      frame = requestAnimationFrame(tick)
      set({ at: playFrom(day, state.at), playing: true })
    },
    pause,
    seek: (at) =>
      set({ at: Math.min(day.close, Math.max(day.start, Math.round(at))) }),
    setSpeed: (speed) => set({ speed }),
    pickMinute: (minute) => {
      pause()
      set({ at: Math.min(day.close, minuteEnd(minute)) })
    },
    dispose: pause,
  }
}

// One figure of the cursor, re-rendering only when it changes: select a
// coarse one (the minute, the second) where the finest isn't needed.
export function useReplay<A>(
  cursor: ReplayCursor,
  select: (state: ReplayState) => A
): A {
  return useSyncExternalStore(
    cursor.subscribe,
    () => select(cursor.state()),
    () => select(cursor.state())
  )
}
