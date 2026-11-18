import { IconVolume, IconVolumeOff } from "@tabler/icons-react"
import { clientRuntime } from "@workspace/client"
import { Effect } from "effect"
import { useEffect, useSyncExternalStore } from "react"

import { KIconButton } from "@/components/k/button"
import { makeStoredValue } from "@/lib/stored-value"

import { wakeSound } from "./sweep-alert-sound"

// Decision: like the watchlist (use-watchlist.ts), each browser keeps the
// Speaker toggle in localStorage, off until turned on (spec
// apinrdw/kumora#510, "Dashboard: Running trades").
const KEY = "kumora:market-live:speaker"
const ON = "on"

// Storage blocked reads as off.
const toggle = Effect.runSync(
  makeStoredValue({
    key: KEY,
    parse: (raw) => Effect.succeed(raw === ON),
    serialize: (on) => Effect.succeed(on ? ON : null),
  })
)
const { subscribe, snapshot, write } = toggle

// Whether the Speaker toggle is on: the sweep alert player reads it at each
// delta.
export const speakerOn = toggle.current

// The Speaker toggle in the live Running trades header. Its click is the
// gesture that lets the browser play the sweep alert sounds. The server
// render has it off.
export function SpeakerToggle() {
  const on = useSyncExternalStore(subscribe, snapshot, () => false)
  // Turned on before this page load: the page's first click or key press
  // wakes the sound, since the toggle's own click is gone with the old page.
  useEffect(() => {
    if (!on) return
    const wake = () => clientRuntime.runFork(wakeSound)
    const options = { once: true, capture: true }
    window.addEventListener("pointerdown", wake, options)
    window.addEventListener("keydown", wake, options)
    return () => {
      window.removeEventListener("pointerdown", wake, options)
      window.removeEventListener("keydown", wake, options)
    }
  }, [on])
  return (
    <KIconButton
      icon={on ? IconVolume : IconVolumeOff}
      label="Sweep alert sound"
      size="sm"
      aria-pressed={on}
      className={on ? "text-foreground" : undefined}
      onClick={() => {
        clientRuntime.runSync(write(!on))
        if (!on) clientRuntime.runFork(wakeSound)
      }}
    />
  )
}
