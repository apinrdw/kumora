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
  "market-hours": "Market hours: walks resume at 16:35 WIB.",
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

const missingCount = (status: BrokerCodesStatus) =>
  Effect.sync(() =>
    status.missing.reduce(
      (sum, [from, to]) => sum + Number(to) - Number(from) + 1,
      0
    )
  )

const heldLabel = Effect.fnUntraced(function* (status: BrokerCodesStatus) {
  if (status.complete) return "Complete"
  const missing = yield* missingCount(status)
  return missing > 0 ? `${yield* count(missing)} missing` : "Incomplete"
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

// One of the last 10 days: complete or how many trades are missing, which
// site supplied it, its cross-check, and whether the extra target's copy is
// behind Production's.
export const dayView = Effect.fnUntraced(function* (
  production: Option.Option<BrokerCodesStatus>,
  extra: Option.Option<BrokerCodesStatus>
) {
  if (Option.isNone(production))
    return { held: "Unknown", sites: "", crossCheck: "", behind: false }
  const status = production.value
  return {
    held: yield* heldLabel(status),
    sites: yield* sitesLabel(status.sources),
    crossCheck: yield* crossCheckLabel(status.crossCheck),
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

// The walk in progress: its site and day, trades fetched of N, pace and
// time left, each blank until known.
export const walkView = Effect.fnUntraced(function* (
  progress: Extract<BrokerCodesProgress, { state: "walking" }>
) {
  const walk = `${progress.feed}, ${progress.day} (${walkNames[progress.walk]})`
  const trades = progress.trades
  if (trades === undefined) return { walk, trades: "", pace: "", left: "" }
  const { fetched, of, perSecond } = trades
  const left =
    of !== null && perSecond !== null && perSecond > 0
      ? `${yield* count(Math.max(1, Math.ceil((of - fetched) / perSecond / 60)))} min left`
      : ""
  return {
    walk,
    trades:
      of === null
        ? `${yield* count(fetched)} trades`
        : `${yield* count(fetched)} of ${yield* count(of)} trades`,
    pace: perSecond === null ? "" : `${yield* count(perSecond)} trades/s`,
    left,
  }
})

// Decision: the History walk is finished once its position says it ended,
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
