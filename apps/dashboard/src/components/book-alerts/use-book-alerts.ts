import { IconArrowDown, IconArrowUp } from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import {
  wibDateAt,
  type BookReadings,
  type StockCode,
  type ViewerDown,
  type WibDate,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { kToast } from "@/components/k/toast"
import { useSpecialBoard } from "@/components/market-live/use-special-board"
import { useWatchlist } from "@/components/market-live/use-watchlist"
import { makeFiguresStore } from "@/components/order-book-radar/figures-store"
import { useRadarSettings } from "@/components/order-book-radar/use-radar-settings"
import {
  admitAlert,
  alertLink,
  alertOf,
  alertRises,
  heavySideChanges,
  ruleMatches,
  withAlert,
  type Alert,
  type AlertEvent,
  type AlertVerdict,
  type HeavySideTags,
  type MatchContext,
} from "@/lib/book-alerts"
import { isCheap } from "@/lib/book-readings"
import { floorValue } from "@/lib/order-book-radar"

import {
  alertBell,
  alertChime,
  alertDay,
  alertHistory,
  alertLimits,
  alertRules,
} from "./alert-store"
import { useAlertOwner } from "./use-alert-owner"

const LIMITS_LOCK = "kumora:book-alerts:limits"

// Decision: each event alerts once per browser, and the cooldowns and the
// minute's count hold across its tabs and reloads: one localStorage value,
// admitted against under the Web Lock `kumora:book-alerts:limits` by the
// alert owner (use-alert-owner.ts) only. An event heard twice cools on its
// own code, kind and time. See apinrdw/kumora#526.
const withLimitsLock = Effect.fnUntraced(function* (
  change: Effect.Effect<void>
) {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks
  // Without Web Locks, or when the request fails before the grant, the
  // change runs unguarded; one that fails under the lock is only logged.
  if (locks === undefined) return yield* change
  let granted = false
  yield* Effect.tryPromise(() =>
    locks.request(LIMITS_LOCK, () => {
      granted = true
      return clientRuntime.runPromise(change)
    })
  ).pipe(
    Effect.catch((error) =>
      granted
        ? Effect.logWarning("A book alert failed under its limits lock", error)
        : change
    )
  )
})

const ALERT_MS = 8_000

const NO_READINGS: ReadonlyArray<BookReadings> = []

// A short tone, once per alert. A page the user hasn't touched yet may
// refuse to play it; with no audio, the toast still shows.
const chime = Effect.try(() => {
  const audio = new AudioContext()
  const tone = audio.createOscillator()
  const gain = audio.createGain()
  tone.frequency.value = 880
  gain.gain.setValueAtTime(0.08, audio.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25)
  tone.connect(gain).connect(audio.destination)
  tone.start()
  tone.stop(audio.currentTime + 0.25)
  tone.addEventListener("ended", () => void audio.close())
}).pipe(Effect.ignore)

// A browser notification, from a tab in the background with permission.
const notify = (
  title: string,
  options: NotificationOptions,
  onClick: () => void
) =>
  Effect.sync(() => {
    if (typeof Notification === "undefined") return
    if (Notification.permission !== "granted") return
    const notification = new Notification(title, options)
    notification.addEventListener("click", () => {
      window.focus()
      onClick()
      notification.close()
    })
  })

const visible = Effect.sync(() => document.visibilityState === "visible")

// Tells one alert, or the fold of the minute's alerts past the limit:
// toasts on the visible page, notifies from a background tab.
const tellAlert = Effect.fnUntraced(function* (
  alert: Alert,
  verdict: AlertVerdict,
  open: (alert: Alert) => void,
  view: () => void
) {
  if (verdict._tag === "Folded") {
    const title = `+${verdict.count} more alerts this minute`
    if (!(yield* visible))
      return yield* notify(title, { tag: "book-alerts-fold" }, view)
    return yield* kToast.info(title, {
      id: `book-alerts-fold-${verdict.since}`,
      duration: ALERT_MS,
      action: { label: "View", onClick: view },
    })
  }
  if (alertChime.get()) yield* chime
  if (!(yield* visible))
    return yield* notify(
      alert.title,
      { body: alert.detail, tag: alert.key },
      () => open(alert)
    )
  const rises = yield* alertRises(alert)
  const tone = rises ? kToast.success : kToast.error
  yield* tone(alert.title, {
    description: alert.detail,
    icon: rises ? IconArrowUp : IconArrowDown,
    duration: ALERT_MS,
    action: { label: "Open", onClick: () => open(alert) },
  })
})

// Admits each matched event against the browser's limits, records each
// alert they let through and tells it.
const admitAll = Effect.fnUntraced(function* (
  matched: ReadonlyArray<AlertEvent>,
  now: number,
  today: WibDate,
  open: (alert: Alert) => void,
  view: () => void
) {
  for (const event of matched) {
    const { verdict, limits } = yield* admitAlert(alertLimits.get(), event, now)
    if (verdict._tag === "Cooled") continue
    alertLimits.set(limits)
    const alert = yield* alertOf(event)
    alertHistory.set(yield* withAlert(alertHistory.get(), alert, today))
    yield* Effect.forkDetach(tellAlert(alert, verdict, open, view))
  }
})

/**
 * Tells this browser's alert rules' matches among a live page's book events
 * (spec apinrdw/kumora#517, "Alerts"), order flow events and heavy side
 * changes (spec apinrdw/kumora#605, "Order flow alerts" and "Heavy side
 * alerts"), once per browser from the page that
 * holds the alert lock (use-alert-owner.ts): a toast on the visible page, a
 * notification from a background tab. The page feeds it every message of
 * its viewer socket; only a delta's new events alert, and a tag a delta's
 * readings change. Every page keeps each code's tag, so one that takes the
 * lock knows what changed. A recorded day's page
 * passes `live` false and never holds the lock.
 */
export function useBookAlerts(live = true) {
  const watchlist = useWatchlist().codes
  const board = useSpecialBoard()
  const { floor } = useRadarSettings().settings
  const [figures] = useState(() => Effect.runSync(makeFiguresStore))
  const context = useMemo((): MatchContext => {
    const watched = new Set(watchlist)
    return {
      watchlist: watched,
      excluded: (code) =>
        board.has(code) || Effect.runSync(isCheap(figures.all().get(code))),
      onScanner: (code: StockCode) =>
        floorValue(figures.all().get(code)) >= floor,
    }
  }, [watchlist, board, floor, figures])
  const held = useRef(context)
  const tags = useRef<HeavySideTags>(new Map())
  const owns = useAlertOwner(live)
  useEffect(() => {
    held.current = context
  }, [context])

  const navigate = useNavigate()
  const open = useCallback(
    (alert: Alert) =>
      void navigate({
        to: "/market-live",
        search: Effect.runSync(alertLink(alert)),
      }),
    [navigate]
  )
  const view = useCallback(() => {
    alertBell.set(true)
    void navigate({ to: "/order-book-radar" })
  }, [navigate])

  return useCallback(
    (message: ViewerDown) => {
      figures.apply(message)
      const today = Effect.runSync(wibDateAt(message.at))
      alertDay.set(today)
      const changes = Effect.runSync(
        heavySideChanges(
          message._tag === "Snapshot" ? new Map() : tags.current,
          message.bookReadings ?? NO_READINGS,
          (code) => figures.all().get(code)
        )
      )
      tags.current = changes.tags
      if (message._tag !== "Delta") return
      const events: ReadonlyArray<AlertEvent> = [
        ...(message.bookEvents ?? []),
        ...(message.orderFlowEvents ?? []),
        ...changes.changes,
      ]
      const rules = alertRules.get()
      if (events.length === 0 || rules.length === 0 || !owns.current) return
      const now = DateTime.toEpochMillis(message.at)
      const matched = events.filter((event) =>
        rules.some((rule) =>
          Effect.runSync(ruleMatches(rule, event, held.current))
        )
      )
      if (matched.length === 0) return
      void clientRuntime.runFork(
        withLimitsLock(admitAll(matched, now, today, open, view))
      )
    },
    [figures, open, view, owns]
  )
}
