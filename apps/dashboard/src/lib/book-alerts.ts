// Book event alerts (spec apinrdw/kumora#517, "Alerts"), heavy side alerts
// and order flow alerts (spec apinrdw/kumora#605, "Heavy side alerts" and
// "Order flow alerts"): which events a
// browser's alert rules match, the rate limit on telling them, and the
// day's history of what was told.
import {
  heavySideOf,
  levelValue,
  limitOf,
  type BookEvent,
  type BookReadings,
  type HeavySide,
  type OrderFlowEvent,
  type StockCode,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"

import { BOOK_EVENT_NAMES, bookEventDetail } from "./book-events"
import type { CodePrices } from "./book-readings"
import { plain, signed } from "./format"
import {
  ORDER_FLOW_LETTERS,
  marketEventKey,
  orderFlowEventFigures,
  orderFlowEventTitle,
} from "./order-flow-events"

// A code's heavy side tag becoming big or small orders (`heavySideChanges`).
export interface HeavySideChange {
  readonly kind: "bigOrders" | "smallOrders"
  readonly code: StockCode
  // The readings' as-of.
  readonly at: DateTime.Utc
  readonly side: HeavySide["side"]
  readonly imbalance: number
  // The heavy side's lots per order, and the other side's.
  readonly heavyPerOrder: number
  readonly otherPerOrder: number
}

// What an alert rule matches: a book event, an order flow event, or a heavy
// side change.
export type AlertEvent = BookEvent | OrderFlowEvent | HeavySideChange
export type AlertKind = AlertEvent["kind"]

const isHeavySideChange = (event: AlertEvent): event is HeavySideChange =>
  event.kind === "bigOrders" || event.kind === "smallOrders"

const isOrderFlowEvent = (event: AlertEvent): event is OrderFlowEvent =>
  Object.hasOwn(ORDER_FLOW_LETTERS, event.kind)

const isBookEvent = (event: AlertEvent): event is BookEvent =>
  Object.hasOwn(BOOK_EVENT_NAMES, event.kind)

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
  readonly kinds: ReadonlyArray<AlertKind>
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

const inScope = (scope: AlertScope, code: StockCode, context: MatchContext) =>
  Effect.sync(() => {
    switch (scope._tag) {
      case "watchlist":
        return context.watchlist.has(code)
      case "codes":
        return scope.codes.includes(code)
      case "scanner":
        return context.onScanner(code)
    }
  })

// The value of the level or wall an event happened to: the lots the level
// shows (absorbed, reloaded), the level's peak (eaten), or the wall's lots,
// at its price. Never the lots traded or lost.
const levelValueOf = (event: BookEvent) =>
  Effect.sync(() => {
    switch (event.kind) {
      case "absorbed":
      case "reloaded":
        return levelValue(event.price, event.shown)
      case "moved":
        return levelValue(event.price, event.wallLots)
      case "eaten":
      case "appeared":
      case "pulled":
        return levelValue(event.price, event.lots)
    }
  })

// A rule's minimum value holds only a book event, the one kind with a level
// or wall to value.
const valueHolds = (rule: AlertRule, event: AlertEvent) =>
  isBookEvent(event)
    ? Effect.map(levelValueOf(event), (value) => value >= rule.minValue)
    : Effect.succeed(true)

export const ruleMatches = Effect.fnUntraced(function* (
  rule: AlertRule,
  event: AlertEvent,
  context: MatchContext
) {
  return (
    rule.kinds.includes(event.kind) &&
    !context.excluded(event.code) &&
    (yield* inScope(rule.scope, event.code, context)) &&
    (yield* valueHolds(rule, event))
  )
})

// An alert's title names a wall's kind in full: the list's "Pulled" chip
// sits beside its wall, a toast stands alone.
const BOOK_EVENT_ALERT_NAMES = { ...BOOK_EVENT_NAMES, pulled: "Wall pulled" }

const ORDER_FLOW_ALERT_NAMES = {
  exhaustion: "Exhaustion",
  divergence: "Delta divergence",
  failedBreak: "Failed break",
}

const HEAVY_SIDE_ALERT_NAMES = {
  bigOrders: "Big orders",
  smallOrders: "Small orders",
}

// Each kind's name, in the rule editor's order: book events, order flow,
// then heavy side.
export const ALERT_KIND_NAMES: Readonly<Record<AlertKind, string>> = {
  ...BOOK_EVENT_ALERT_NAMES,
  ...ORDER_FLOW_ALERT_NAMES,
  ...HEAVY_SIDE_ALERT_NAMES,
}

// Whether a rule kind is a book event's: the only kinds a minimum value
// holds.
export const isBookEventKind = (kind: AlertKind) => kind in BOOK_EVENT_NAMES

const LEANS = { bid: "Bid-heavy", offer: "Offer-heavy" } as const
const ORDERS = { bigOrders: "big orders", smallOrders: "small orders" } as const

// "BBCA · Wall pulled on the bid", "BBCA · Offer-heavy with big orders",
// "BBCA · Buying exhaustion at the day's high".
export const alertTitle = Effect.fnUntraced(function* (event: AlertEvent) {
  if (isHeavySideChange(event))
    return `${event.code} · ${LEANS[event.side]} with ${ORDERS[event.kind]}`
  if (isOrderFlowEvent(event))
    return `${event.code} · ${yield* orderFlowEventTitle(event)}`
  return `${event.code} · ${ALERT_KIND_NAMES[event.kind]} on the ${event.side}`
})

// A heavy side alert's detail: "−72% · 118 vs 22 lots per order".
const heavySideDetail = Effect.fnUntraced(function* (change: HeavySideChange) {
  const imbalance = yield* signed(change.imbalance * 100, 0)
  const heavy = yield* plain(change.heavyPerOrder, 0)
  const other = yield* plain(change.otherPerOrder, 0)
  return `${imbalance}% · ${heavy} vs ${other} lots per order`
})

// A heavy side alert's key: unique per code, kind, side and time. Market
// Live's readout picks no event by it.
const heavySideKey = (change: HeavySideChange) =>
  Effect.sync(
    () =>
      `${change.code}|${change.kind}|${change.side}|${DateTime.toEpochMillis(change.at)}`
  )

const alertDetail = (event: AlertEvent) =>
  isHeavySideChange(event)
    ? heavySideDetail(event)
    : isOrderFlowEvent(event)
      ? orderFlowEventFigures(event)
      : bookEventDetail(event)

// The alert told for an event: its key, the event Market Live picks, its
// title and detail.
export const alertOf = Effect.fnUntraced(function* (event: AlertEvent) {
  const heavy = isHeavySideChange(event)
  const key = heavy ? yield* heavySideKey(event) : yield* marketEventKey(event)
  return {
    key,
    event: heavy ? undefined : key,
    code: event.code,
    side: event.side,
    title: yield* alertTitle(event),
    detail: yield* alertDetail(event),
    at: DateTime.toEpochMillis(event.at),
  } satisfies Alert
})

// Where an alert's Open lands on Market Live: its code, and its event when
// the readout lists one.
export const alertLink = (alert: Alert) =>
  Effect.succeed({ code: alert.code, event: alert.event })

// Whether an alert reads as the bid's or the buyers': green and up.
export const alertRises = (alert: Alert) =>
  alert.side === "bid" || alert.side === "buy"

// Each code's heavy side tag as of the readings heard so far; a code
// missing has none.
export type HeavySideTags = ReadonlyMap<StockCode, HeavySide>

const changeOf = (
  readings: BookReadings,
  heavy: HeavySide
): HeavySideChange => {
  const [mine, other] =
    heavy.side === "bid"
      ? [readings.bid, readings.offer]
      : [readings.offer, readings.bid]
  return {
    kind: heavy.orders === "big" ? "bigOrders" : "smallOrders",
    code: readings.code,
    at: readings.at,
    side: heavy.side,
    imbalance: readings.imbalance ?? 0,
    heavyPerOrder: mine.lotsPerOrder ?? 0,
    otherPerOrder: other.lotsPerOrder ?? 0,
  }
}

// The tags after `readings`, and each code whose tag became big or small
// orders: from none, the other tag, or the other side's. A tag that stays,
// or goes to none, is no change. `pricesOf` tells a code at a limit, which
// has no tag.
export const heavySideChanges = Effect.fnUntraced(function* (
  tags: HeavySideTags,
  readings: ReadonlyArray<BookReadings>,
  pricesOf: (code: StockCode) => CodePrices | undefined
) {
  const next = new Map(tags)
  const changes: Array<HeavySideChange> = []
  for (const each of readings) {
    const prices = pricesOf(each.code) ?? {
      last: undefined,
      previousClose: undefined,
    }
    const heavy = yield* heavySideOf(each, yield* limitOf(each, prices))
    const before = tags.get(each.code)
    if (heavy === undefined) {
      next.delete(each.code)
      continue
    }
    next.set(each.code, heavy)
    if (before?.side !== heavy.side || before.orders !== heavy.orders)
      changes.push(changeOf(each, heavy))
  }
  return { tags: next as HeavySideTags, changes }
})

// Decision: the same code and kind alert at most once in 2 minutes, and at
// most 6 alerts a minute; the rest of that minute fold into one count. See
// spec apinrdw/kumora#517, "Alerts".
const COOLDOWN_MS = 120_000
const CAP_WINDOW_MS = 60_000
const CAP = 6

export type AlertVerdict =
  | { readonly _tag: "Cooled" }
  | { readonly _tag: "Shown" }
  // One more folded into the count that started at `since`.
  | { readonly _tag: "Folded"; readonly count: number; readonly since: number }

// The browser's rate limit so far: what `admitAlert` reads and returns.
export interface AlertLimits {
  // Each code and kind's last alert, by its event's time.
  readonly last: Readonly<Record<string, number>>
  // The shown alerts' times in the last minute.
  readonly shown: ReadonlyArray<number>
  readonly fold: { readonly since: number; readonly count: number } | null
}

export const NO_LIMITS: AlertLimits = { last: {}, shown: [], fold: null }

// A code and kind's last alert is forgotten half an hour behind the
// object's clock: a pull read two sparse frames late still lands within it.
const FORGET_MS = 1_800_000

// Whether a matched event is told, at `now` on the object's clock, and the
// limits after it.
export const admitAlert = (
  limits: AlertLimits,
  event: AlertEvent,
  now: number
) =>
  Effect.sync((): { verdict: AlertVerdict; limits: AlertLimits } => {
    const key = `${event.code}|${event.kind}`
    const at = DateTime.toEpochMillis(event.at)
    const before = limits.last[key]
    if (before !== undefined && at - before < COOLDOWN_MS)
      return { verdict: { _tag: "Cooled" }, limits }
    const last = Object.fromEntries(
      Object.entries(limits.last).filter(([, t]) => t > now - FORGET_MS)
    )
    last[key] = at
    const shown = limits.shown.filter((t) => t > now - CAP_WINDOW_MS)
    if (shown.length < CAP)
      return {
        verdict: { _tag: "Shown" },
        limits: { last, shown: [...shown, now], fold: limits.fold },
      }
    const fold =
      limits.fold !== null && now - limits.fold.since < CAP_WINDOW_MS
        ? { since: limits.fold.since, count: limits.fold.count + 1 }
        : { since: now, count: 1 }
    return {
      verdict: { _tag: "Folded", ...fold },
      limits: { last, shown, fold },
    }
  })

// One alert as the bell lists it.
export interface Alert {
  // The event's key (lib/order-flow-events.ts `marketEventKey`, or
  // `heavySideKey`).
  readonly key: string
  // The key Open picks on Market Live: a book or order flow event's; none
  // for a heavy side change, which the readout doesn't list.
  readonly event?: string | undefined
  readonly code: StockCode
  readonly side: AlertEvent["side"]
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
