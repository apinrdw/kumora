// What the options page's Broker codes section says (spec
// apinrdw/kumora#244, "The extension: options page and badge"), from what
// the worker stores and the targets' day statuses.
import type { BrokerCodesStatus, Feed, WibDate } from "@workspace/relay"
import { Effect, Option } from "effect"

import { lockReasons, type AjaibLock } from "../worker/ajaib-lock.ts"
import { holdsSame } from "../worker/broker-codes/extra-target.ts"
import type { HistoryPosition } from "../worker/broker-codes/history.ts"
import type { BrokerCodesTarget } from "../worker/broker-codes/poster.ts"
import type {
  BrokerCodesProgress,
  PauseCause,
  StallCause,
  WalkPhase,
} from "../worker/broker-codes/run-queue.ts"
import { fetchGet, statusOnce } from "../worker/broker-codes/status.ts"

const count = (value: number) => Effect.sync(() => value.toLocaleString("en"))

const wibClock = (epochMs: number) =>
  Effect.sync(() =>
    new Date(epochMs).toLocaleTimeString("en-GB", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
    })
  )

const causeLabels: Record<PauseCause, string> = {
  "streaming-hours":
    "Streaming hours: walks resume when the live relay stops at 16:35 WIB.",
  "no-tab": "No broker tab: open a signed-in Stockbit or Ajaib tab.",
  "no-token": "No Production ingest token.",
  "rejected-token": "Production rejected the ingest token. Fix it and save.",
  "reload-extension":
    "The dashboard no longer accepts this extension. Rebuild and reload it.",
  paused: "Paused by the owner.",
  "signed-out": "Stockbit signed out: sign in again in the Stockbit tab.",
}

// Why the walks wait: the queue's pause, the owner's switch while the
// worker hasn't yet stopped, the Ajaib tab's lock, and each site's throttle
// until it ends.
export const causesView = Effect.fnUntraced(function* (stored: {
  readonly progress: Option.Option<BrokerCodesProgress>
  readonly paused: boolean
  readonly lock: Option.Option<AjaibLock>
  readonly throttled: ReadonlyArray<readonly [feed: Feed, until: number]>
}) {
  const cause = Option.flatMap(stored.progress, (progress) =>
    progress.state === "paused" ? Option.some(progress.cause) : Option.none()
  )
  const causes = Option.toArray(Option.map(cause, (each) => causeLabels[each]))
  if (stored.paused && !Option.contains(cause, "paused"))
    causes.push(causeLabels.paused)
  const lock = Option.getOrUndefined(stored.lock)
  if (lock?.state === "locked")
    causes.push(`Ajaib locked: ${lockReasons[lock.reason].fix}`)
  for (const [feed, until] of stored.throttled)
    causes.push(`${feed} throttled until ${yield* wibClock(until)} WIB.`)
  return causes
})

// A day's status from a target, asked once; none when it gave none.
export const dayStatus = (target: BrokerCodesTarget, day: WibDate) =>
  statusOnce(fetchGet, target, day)

const heldLabel = Effect.fnUntraced(function* (status: BrokerCodesStatus) {
  if (status.complete) return "Complete"
  return status.missingCount > 0
    ? `${yield* count(status.missingCount)} missing`
    : "Incomplete"
})

// The listed missing ranges as "262,370" or "5–9", and how many trades
// `missingCount` counts past them: the list stops at MISSING_RANGES.
const missingLabels = Effect.fnUntraced(function* (status: BrokerCodesStatus) {
  const missing: Array<string> = []
  let listed = 0
  for (const [from, to] of status.missing) {
    const first = Number(from)
    const last = Number(to)
    listed += last - first + 1
    missing.push(
      first === last
        ? yield* count(first)
        : `${yield* count(first)}–${yield* count(last)}`
    )
  }
  return { missing, more: Math.max(0, status.missingCount - listed) }
})

const siteNames = {
  both: "Ajaib and Stockbit",
  ajaib: "Ajaib",
  stockbit: "Stockbit",
  none: "None",
} as const

const sitesLabel = Effect.fnUntraced(function* ({
  ajaib,
  stockbit,
}: BrokerCodesStatus["sources"]) {
  if (ajaib > 0) return stockbit > 0 ? siteNames.both : siteNames.ajaib
  return stockbit > 0 ? siteNames.stockbit : siteNames.none
})

const crossCheckLabel = Effect.fnUntraced(function* (
  crossCheck: BrokerCodesStatus["crossCheck"]
) {
  if (crossCheck.state === "none") return "no cross-check"
  if (crossCheck.state === "pending") return "checking"
  if (crossCheck.differences === 0) return "matches"
  return `${yield* count(crossCheck.differences)} differences`
})

// The trades holding order numbers from each site and how many of
// Stockbit's differed, as "1,311 from Ajaib, 23 from Stockbit, 4 differ";
// blank for a day holding none, as every day recorded before them.
const orderNumbersLabel = Effect.fnUntraced(function* ({
  ajaib,
  stockbit,
  differences,
}: BrokerCodesStatus["orderNumbers"]) {
  const parts: Array<string> = []
  if (ajaib > 0) parts.push(`${yield* count(ajaib)} from Ajaib`)
  if (stockbit > 0) parts.push(`${yield* count(stockbit)} from Stockbit`)
  if (differences > 0) parts.push(`${yield* count(differences)} differ`)
  return parts.join(", ")
})

// One of the last 10 days: complete or how many trades are missing and
// which, which site supplied it, its cross-check, its trades with order
// numbers, and whether the extra target's copy is behind Production's.
export const dayView = Effect.fnUntraced(function* (
  production: Option.Option<BrokerCodesStatus>,
  extra: Option.Option<BrokerCodesStatus>
) {
  if (Option.isNone(production))
    return {
      held: "Unknown",
      missing: [],
      more: 0,
      sites: "",
      crossCheck: "",
      orderNumbers: "",
      behind: false,
    }
  const status = production.value
  return {
    held: yield* heldLabel(status),
    ...(yield* missingLabels(status)),
    sites: yield* sitesLabel(status.sources),
    crossCheck: yield* crossCheckLabel(status.crossCheck),
    orderNumbers: yield* orderNumbersLabel(status.orderNumbers),
    behind:
      Option.isSome(extra) &&
      !extra.value.complete &&
      !(yield* holdsSame(status, extra.value)),
  }
})

const walkNames: Record<
  Extract<BrokerCodesProgress, { state: "walking" }>["walk"],
  string
> = {
  newest: "newest closed day",
  gaps: "gaps",
  history: "History",
}

// How long `remaining` takes at a pace, blank until both are known and
// when nothing remains.
const leftLabel = Effect.fnUntraced(function* (
  remaining: number | null,
  perSecond: number | null
) {
  if (remaining === null || remaining <= 0) return ""
  if (perSecond === null || perSecond <= 0) return ""
  return `${yield* count(Math.max(1, Math.ceil(remaining / perSecond / 60)))} min left`
})

const stallKinds: Record<StallCause["kind"], string> = {
  "refused-token": "Ajaib refused the walk token",
  "no-answer": "the Ajaib tab got no answer",
  timeout: "the Ajaib tab didn't answer in time",
}

// Why a call is retrying in place, after its phase; blank while none is.
const stallLabel = Effect.fnUntraced(function* (stall: StallCause | undefined) {
  if (stall === undefined) return ""
  const calls = stall.failures === 1 ? "call" : "calls"
  const token = stall.tokenChanged
    ? "walk token changed since the first"
    : "walk token unchanged"
  return `, retrying: ${stallKinds[stall.kind]}, ${yield* count(stall.failures)} ${calls} failed in a row, ${token}`
})

// What the walk is doing and since when, in WIB; blank until it says.
const phaseLabel = Effect.fnUntraced(function* (phase: WalkPhase | undefined) {
  if (phase === undefined) return ""
  const since = yield* wibClock(phase.since)
  const stall = yield* stallLabel(phase.stall)
  switch (phase.step) {
    case "awaiting-close":
      return `waiting for Ajaib's close since ${since}${stall}`
    case "fetching": {
      const { pass, page, pages } = phase
      const at =
        pass === undefined || page === undefined || pages === undefined
          ? ""
          : `, ${pass} pass, page ${yield* count(page)} of ${yield* count(pages)}`
      return `fetching since ${since}${at}${stall}`
    }
    case "awaiting-token":
      return phase.reloads === 0
        ? `waiting for a fresh Ajaib token since ${since}${stall}`
        : `waiting for a fresh Ajaib token since ${since}, tab reloaded ${yield* count(phase.reloads)}×${stall}`
  }
})

// The walk in progress: its site and day, what it is doing since when,
// trades fetched of N, the Done Details walk's codes walked of the day's,
// pace and time left, each blank until known.
export const walkView = Effect.fnUntraced(function* (
  progress: Extract<BrokerCodesProgress, { state: "walking" }>
) {
  const site =
    progress.route === "done-details"
      ? `${progress.feed} Done Details`
      : progress.feed
  const walk = `${site}, ${progress.day} (${walkNames[progress.walk]})`
  const phase = yield* phaseLabel(progress.phase)
  const { trades, stockCodes } = progress
  const codes =
    stockCodes === undefined
      ? ""
      : `${yield* count(stockCodes.done)} of ${yield* count(stockCodes.of)} codes`
  const fetched =
    trades === undefined
      ? ""
      : trades.of === null
        ? `${yield* count(trades.fetched)} trades`
        : `${yield* count(trades.fetched)} of ${yield* count(trades.of)} trades`
  if (trades === undefined)
    return { walk, phase, trades: "", codes, pace: "", left: "" }
  const { of, perSecond } = trades
  return {
    walk,
    phase,
    trades: fetched,
    codes,
    pace: perSecond === null ? "" : `${yield* count(perSecond)} trades/s`,
    left: yield* leftLabel(of === null ? null : of - trades.fetched, perSecond),
  }
})

// The History walk is finished once its position says it ended,
// running while the queue walks a History day, and waiting otherwise. See
// apinrdw/kumora#252.
export const historyView = Effect.fnUntraced(function* (
  position: Option.Option<HistoryPosition>,
  progress: Option.Option<BrokerCodesProgress>
) {
  const state = Option.exists(position, ({ ended }) => ended)
    ? "Finished"
    : Option.exists(
          progress,
          (each) => each.state === "walking" && each.walk === "history"
        )
      ? "Running"
      : "Waiting"
  return Option.match(position, {
    onNone: () => `${state}. No day reached yet.`,
    onSome: ({ oldest }) => `${state}. Oldest day reached: ${oldest}.`,
  })
})
