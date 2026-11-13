// The toolbar badge (spec apinrdw/kumora#244, "The extension: options page
// and badge"): the worst target state, then the broker codes pauses only the
// owner can clear.
import { Effect, Option } from "effect"

import { lockReasons, type AjaibLock } from "./ajaib-lock.ts"
import type { BrokerCodesProgress } from "./broker-codes/run-queue.ts"
import type { TargetState, TargetStates } from "./settings.ts"

const targetBadges: Record<TargetState, { text: string; title: string }> = {
  off: { text: "", title: "no ingest token" },
  connected: { text: "", title: "relaying" },
  connecting: { text: "…", title: "connecting" },
  retrying: { text: "…", title: "unreachable, retrying" },
  "rejected-token": { text: "KEY", title: "ingest token rejected" },
  "reload-extension": { text: "RLD", title: "reload extension" },
}
const severity: ReadonlyArray<TargetState> = [
  "reload-extension",
  "rejected-token",
  "retrying",
  "connecting",
  "connected",
  "off",
]

// Decision: a target state with a badge of its own shows first; only when
// none does, `PIN` (the Ajaib tab locked) and then `OUT` (the Stockbit tab
// signed out). Progress, throttling, Streaming hours and the owner's pause
// never show, since nothing waits on the owner. See apinrdw/kumora#244,
// "The badge".
export const badgeOf = Effect.fnUntraced(function* (stored: {
  readonly states: Option.Option<TargetStates>
  readonly lock: Option.Option<AjaibLock>
  readonly progress: Option.Option<BrokerCodesProgress>
}) {
  const states = Option.getOrElse(stored.states, (): TargetStates => ({
    production: "off",
    extra: "off",
  }))
  const worst =
    severity.find((state) => Object.values(states).includes(state)) ?? "off"
  const lines = Object.entries(states).map(
    ([name, state]) => `${name}: ${targetBadges[state].title}`
  )
  const lock = Option.getOrUndefined(stored.lock)
  const locked =
    lock?.state === "locked"
      ? `Ajaib locked: ${lockReasons[lock.reason].cause}`
      : undefined
  const signedOut = Option.exists(
    stored.progress,
    (progress) => progress.state === "paused" && progress.cause === "signed-out"
  )
  if (locked !== undefined) lines.push(locked)
  if (signedOut) lines.push("Stockbit signed out")
  const text =
    targetBadges[worst].text !== ""
      ? targetBadges[worst].text
      : locked !== undefined
        ? "PIN"
        : signedOut
          ? "OUT"
          : ""
  return { text, title: ["Kumora relay", ...lines].join("\n") }
})
