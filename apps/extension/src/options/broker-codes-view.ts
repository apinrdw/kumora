// What the options page's Broker codes section says (spec
// apinrdw/kumora#244, "The extension: options page and badge"), from what
// the worker stores and the targets' day statuses.
import {
  brokerCodesPath,
  decodeBrokerCodesStatus,
  type BrokerCodesStatus,
  type WibDate,
} from "@workspace/relay"
import { Effect, Option } from "effect"

import { holdsSame } from "../worker/broker-codes/extra-target.ts"
import { fetchGet } from "../worker/broker-codes/status.ts"
import type { HistoryPosition } from "../worker/broker-codes/history.ts"
import type {
  BrokerCodesProgress,
  PauseCause,
} from "../worker/broker-codes/run-queue.ts"

const count = (value: number) => value.toLocaleString("en")

export const causeLabels: Record<PauseCause, string> = {
  "market-hours": "Market hours: walks resume at 16:35 WIB.",
  "no-tab": "No broker tab: open a signed-in Stockbit or Ajaib tab.",
  "no-token": "No Production ingest token.",
  "rejected-token": "Production rejected the ingest token. Fix it and save.",
  "reload-extension":
    "The dashboard no longer accepts this extension. Rebuild and reload it.",
  paused: "Paused by the owner.",
  "signed-out": "Stockbit signed out: sign in again in the Stockbit tab.",
}

// A day's status from a target, asked once; none when it gave none.
export const dayStatus = Effect.fnUntraced(function* (
  target: { readonly origin: string; readonly token: string },
  day: WibDate
) {
  const path = yield* brokerCodesPath(day)
  const answer = yield* fetchGet({
    url: `${target.origin}${path}`,
    token: target.token,
  })
  if (answer.status !== 200) return Option.none<BrokerCodesStatus>()
  return yield* Effect.option(decodeBrokerCodesStatus(answer.body))
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
  const missing = status.missing.reduce(
    (sum, [from, to]) => sum + Number(to) - Number(from) + 1,
    0
  )
  const { ajaib, stockbit } = status.sources
  const sites =
    ajaib > 0 && stockbit > 0
      ? "Ajaib and Stockbit"
      : ajaib > 0
        ? "Ajaib"
        : stockbit > 0
          ? "Stockbit"
          : "None"
  const { crossCheck } = status
  const checked =
    crossCheck.state === "none"
      ? "no cross-check"
      : crossCheck.state === "pending"
        ? "checking"
        : crossCheck.differences === 0
          ? "matches"
          : `${count(crossCheck.differences)} differences`
  const behind =
    Option.isSome(extra) &&
    !extra.value.complete &&
    !(yield* holdsSame(status, extra.value))
  return {
    held: status.complete
      ? "Complete"
      : missing > 0
        ? `${count(missing)} missing`
        : "Incomplete",
    sites,
    crossCheck: checked,
    behind,
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
      ? `${count(Math.max(1, Math.ceil((of - fetched) / perSecond / 60)))} min left`
      : ""
  return {
    walk,
    trades:
      of === null
        ? `${count(fetched)} trades`
        : `${count(fetched)} of ${count(of)} trades`,
    pace: perSecond === null ? "" : `${count(perSecond)} trades/s`,
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
