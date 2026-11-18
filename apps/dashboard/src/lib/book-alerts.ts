// Book event alerts (spec apinrdw/kumora#517, "Alerts"): which events a
// browser's alert rules match, the rate limit on telling them, and the
// day's history of what was told.
import {
  levelValue,
  type BookEvent,
  type BookEventKind,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

// Decision: a rule's optional minimum level or wall value: any, Rp1 B, Rp5 B
// or Rp20 B. See spec apinrdw/kumora#517, "Alerts".
export const MIN_VALUES = [0, 1e9, 5e9, 20e9] as const
export type MinValue = (typeof MIN_VALUES)[number]

export type AlertScope =
  | { readonly _tag: "watchlist" }
  | { readonly _tag: "codes"; readonly codes: ReadonlyArray<StockCode> }
  | { readonly _tag: "scanner" }

export interface AlertRule {
  readonly id: string
  readonly kinds: ReadonlyArray<BookEventKind>
  readonly scope: AlertScope
  readonly minValue: MinValue
}

// What a rule is matched against besides the event.
export interface MatchContext {
  readonly watchlist: ReadonlySet<StockCode>
  // A Special Monitoring Board code, or one at Rp1–10: never alerts.
  readonly excluded: (code: StockCode) => boolean
  // Whether the scanner shows the code: above the browser's value floor.
  readonly onScanner: (code: StockCode) => boolean
}

const inScope = (scope: AlertScope, code: StockCode, context: MatchContext) => {
  switch (scope._tag) {
    case "watchlist":
      return context.watchlist.has(code)
    case "codes":
      return scope.codes.includes(code)
    case "scanner":
      return context.onScanner(code)
  }
}

// The level's or wall's value: its lots at its price.
const valueOf = (event: BookEvent) => levelValue(event.price, event.lots)

export const ruleMatches = (
  rule: AlertRule,
  event: BookEvent,
  context: MatchContext
) =>
  Effect.sync(
    () =>
      rule.kinds.includes(event.kind) &&
      !context.excluded(event.code) &&
      inScope(rule.scope, event.code, context) &&
      valueOf(event) >= rule.minValue
  )

// An alert's title names a wall's kind in full: the list's "Pulled" chip
// sits beside its wall, a toast stands alone.
export const ALERT_KIND_NAMES: Readonly<Record<BookEventKind, string>> = {
  absorbed: "Absorbed",
  eaten: "Eaten",
  reloaded: "Reloaded",
  appeared: "Wall appeared",
  pulled: "Wall pulled",
  moved: "Wall moved",
}

// "BBCA · Wall pulled on the bid".
export const alertTitle = (event: BookEvent) =>
  Effect.sync(
    () => `${event.code} · ${ALERT_KIND_NAMES[event.kind]} on the ${event.side}`
  )

// Decision: the same code and kind alert at most once in 2 minutes, and at
// most 6 alerts a minute; the rest of that minute fold into one count. See
// spec apinrdw/kumora#517, "Alerts".
const COOLDOWN_MS = 120_000
const CAP_WINDOW_MS = 60_000
const CAP = 6

export type GateVerdict =
  | { readonly _tag: "Cooled" }
  | { readonly _tag: "Shown" }
  // One more folded into the count that started at `since`.
  | { readonly _tag: "Folded"; readonly count: number; readonly since: number }

export interface AlertGate {
  // Whether a matched event is told, at `now` on the object's clock.
  readonly admit: (event: BookEvent, now: number) => Effect.Effect<GateVerdict>
}

export const makeAlertGate = Effect.sync((): AlertGate => {
  // Each code and kind's last alert, by its event's time.
  const last = new Map<string, number>()
  // The shown alerts' times in the last minute.
  let shown: Array<number> = []
  let fold: { since: number; count: number } | undefined
  return {
    admit: (event, now) =>
      Effect.sync((): GateVerdict => {
        const key = `${event.code}|${event.kind}`
        const at = DateTime.toEpochMillis(event.at)
        const before = last.get(key)
        if (before !== undefined && at - before < COOLDOWN_MS)
          return { _tag: "Cooled" }
        last.set(key, at)
        shown = shown.filter((t) => t > now - CAP_WINDOW_MS)
        if (shown.length < CAP) {
          shown.push(now)
          return { _tag: "Shown" }
        }
        fold =
          fold !== undefined && now - fold.since < CAP_WINDOW_MS
            ? { since: fold.since, count: fold.count + 1 }
            : { since: now, count: 1 }
        return { _tag: "Folded", ...fold }
      }),
  }
})

// One alert as the bell lists it.
export interface Alert {
  // The event's key (lib/book-events.ts), which Open picks on Market Live.
  readonly key: string
  readonly code: StockCode
  readonly side: BookEvent["side"]
  readonly title: string
  readonly detail: string
  // The event's time.
  readonly at: number
}

export interface AlertHistory {
  readonly day: WibDate
  // Newest first.
  readonly alerts: ReadonlyArray<Alert>
}

// Decision: the bell keeps today's newest 200 alerts and clears each
// trading day. See spec apinrdw/kumora#517, "Alerts".
const HISTORY_CAP = 200

// The history kept for `today`: empty when it was another day's.
export const historyOf = (history: AlertHistory, today: WibDate) =>
  Effect.sync((): AlertHistory =>
    history.day === today ? history : { day: today, alerts: [] }
  )

export const withAlert = Effect.fnUntraced(function* (
  history: AlertHistory,
  alert: Alert,
  today: WibDate
) {
  const kept = yield* historyOf(history, today)
  return {
    day: today,
    alerts: [alert, ...kept.alerts].slice(0, HISTORY_CAP),
  } satisfies AlertHistory
})
