// Ajaib's idle PIN lock on the relayed tab (spec apinrdw/kumora#244, "The
// extension: Ajaib keep-alive and the PIN lock"). A locked page stops
// renewing its sign-in, so the relay keeps the lock away and, if it shows
// anyway, types the owner's PIN into it once.
import { Duration, Effect, Option, Queue, Schema } from "effect"

import type { PinStore, SignIn } from "./ajaib-session.ts"
import type { Answer, LocalRequest, PageEvent } from "./broker.ts"

// Decision: one synthetic `mousemove` every 10 minutes, all day while an
// Ajaib tab is relayed, Streaming hours included. Ajaib's lock is a 4 h
// idle timeout that a synthetic `mousemove` re-arms, as probed on
// 2026-11-13. See apinrdw/kumora#243.
const KEEP_ALIVE = Duration.minutes(10)

// The worker's clock times the refusal, not the tab's: a background tab's
// timers are throttled.
const REFUSAL_WAIT = Duration.seconds(10)

// A sign-in still to answer: its PIN is typed once it has signed in.
const PENDING: ReadonlyArray<SignIn["state"]> = ["waiting", "signing-in"]

export const makeAjaibLock = Effect.fnUntraced(function* (options: {
  readonly tab: {
    readonly attached: Effect.Effect<boolean>
    readonly request: (
      request: LocalRequest
    ) => Effect.Effect<Option.Option<Answer>>
  }
  readonly pins: PinStore
  readonly save: (lock: AjaibLock) => Effect.Effect<void>
}) {
  const { tab, pins } = options
  const events = yield* Queue.unbounded<PageEvent | { readonly _tag: "tick" }>()

  const keepAlive = Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep(KEEP_ALIVE)
      if (yield* tab.attached) yield* tab.request({ _tag: "activity" })
    })
  )

  // What the page last said: the lock screen showing or not.
  let locked = false
  // None until this worker saved a state: session storage outlives a worker
  // restart, so the first state is saved even when it is unlocked.
  let lock = Option.none<AjaibLock>()
  const record = (next: AjaibLock) =>
    Effect.suspend(() => {
      if (
        Option.isSome(lock) &&
        JSON.stringify(next) === JSON.stringify(lock.value)
      )
        return Effect.void
      lock = Option.some(next)
      return options.save(next)
    })

  // Decision: after the PIN is typed the lock screen is given the whole
  // REFUSAL_WAIT: refused at once on a non-200 answer to the page's PIN
  // validate call, else by whether it still shows at the end. A screen that
  // goes and comes back sooner is the one just typed into, redrawn, since
  // Ajaib's idle lock takes 4 h; ending on its going would type again.
  const refused = Effect.gen(function* () {
    const answered = yield* Effect.timeoutOption(
      Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(events)
          if (event._tag === "lock") locked = event.locked
          if (event._tag === "pin-validated" && event.status !== 200) return
        }
      }),
      REFUSAL_WAIT
    )
    return Option.isSome(answered) || locked
  })

  // Decision: the lock screen gets the kept PIN once per lock, and only from
  // an entry read whole, last thing before `type-pin`, as `signed-in` and
  // marked `typing`. The mark is stored first and cleared once the screen
  // has gone, so a try a restart cut short is found and counts as refused.
  // A refused PIN is wiped. See apinrdw/kumora#244, "Unlock".
  const unlock = Effect.gen(function* () {
    const kept = Option.filter(yield* pins.latest, (entry) =>
      Option.isSome(entry.pin)
    )
    if (Option.exists(kept, (entry) => PENDING.includes(entry.signIn.state)))
      return yield* record({ state: "unlocking" })
    if (Option.isNone(kept) || kept.value.signIn.state !== "signed-in")
      return Option.exists(lock, (each) => each.state === "locked")
        ? undefined
        : yield* record({ state: "locked", reason: "no-pin" })
    const entry = kept.value
    if (!entry.typing) {
      yield* record({ state: "unlocking" })
      yield* entry.setTyping(true)
      const pin = Option.flatMap(yield* pins.latest, (now) =>
        now.typing && now.signIn.state === "signed-in"
          ? now.pin
          : Option.none<string>()
      )
      // A newer entry took its place: that one waits for its own sign-in.
      if (Option.isNone(pin)) return
      const typed = yield* tab.request({ _tag: "type-pin", pin: pin.value })
      if (Option.isSome(typed) && typed.value.status !== 200) {
        yield* entry.setTyping(false)
        return yield* record({ state: "locked", reason: "not-typed" })
      }
      if (!(yield* refused)) {
        yield* entry.setTyping(false)
        return yield* record({ state: "unlocked" })
      }
    }
    yield* entry.wipePin
    yield* record({ state: "locked", reason: "refused" })
  })

  // A lock seen on a page event, or still there on a tick, is unlocked if it
  // can be.
  const run = Effect.forever(
    Effect.gen(function* () {
      const event = yield* Queue.take(events)
      if (event._tag === "pin-validated") return
      if (event._tag === "lock") locked = event.locked
      if (!locked) return yield* record({ state: "unlocked" })
      yield* unlock
    })
  )

  return {
    keepAlive,
    run,
    page: (event: PageEvent) => Effect.asVoid(Queue.offer(events, event)),
    tick: Effect.asVoid(Queue.offer(events, { _tag: "tick" })),
  }
})

// Where the relayed tab's lock stands, for the options page and badge:
// unlocked, being unlocked with the stored PIN, or locked with no way for the
// relay to unlock it, and why.
export const AjaibLock = Schema.Union([
  Schema.Struct({ state: Schema.Literals(["unlocked", "unlocking"]) }),
  Schema.Struct({
    state: Schema.Literal("locked"),
    reason: Schema.Literals(["no-pin", "refused", "not-typed"]),
  }),
])
export type AjaibLock = typeof AjaibLock.Type

// Each reason the tab stays locked: the badge's tooltip names its cause,
// and the options page says what the owner can do. Both follow
// "Ajaib locked: ".
export const lockReasons: Record<
  Extract<AjaibLock, { state: "locked" }>["reason"],
  { readonly cause: string; readonly fix: string }
> = {
  "no-pin": {
    cause: "no PIN entered",
    fix: "enter the PIN below, or unlock the Ajaib tab.",
  },
  refused: {
    cause: "the PIN was refused",
    fix: "Ajaib refused the PIN. Enter it again.",
  },
  "not-typed": {
    cause: "the PIN could not be typed",
    fix: "the PIN could not be typed. Unlock the Ajaib tab.",
  },
}
