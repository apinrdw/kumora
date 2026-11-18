import { IconArrowDown, IconArrowUp } from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import {
  wibDateAt,
  type BookEvent,
  type StockCode,
  type ViewerDown,
} from "@workspace/relay"
import { DateTime, Effect } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { kToast } from "@/components/k/toast"
import { useSpecialBoard } from "@/components/market-live/use-special-board"
import { useWatchlist } from "@/components/market-live/use-watchlist"
import { makeFiguresStore } from "@/components/order-book-radar/figures-store"
import { useRadarSettings } from "@/components/order-book-radar/use-radar-settings"
import {
  alertTitle,
  makeAlertGate,
  ruleMatches,
  withAlert,
  type Alert,
  type GateVerdict,
  type MatchContext,
} from "@/lib/book-alerts"
import { bookEventDetail, bookEventKey } from "@/lib/book-events"
import { isCheap } from "@/lib/book-readings"
import { floorValue } from "@/lib/order-book-radar"

import {
  alertBell,
  alertChime,
  alertDay,
  alertHistory,
  alertRules,
} from "./alert-store"
import { useAlertOwner } from "./use-alert-owner"

// One gate for the tab: moving between the radar and Market Live keeps the
// cooldowns and the minute's count. It advances in every tab, owner or not
// (use-alert-owner.ts).
const gate = Effect.runSync(makeAlertGate)

const ALERT_MS = 8_000

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

// The alert told for an event: its title, detail and key.
const alertOf = Effect.fnUntraced(function* (event: BookEvent) {
  return {
    key: yield* bookEventKey(event),
    code: event.code,
    side: event.side,
    title: yield* alertTitle(event),
    detail: yield* bookEventDetail(event),
    at: DateTime.toEpochMillis(event.at),
  } satisfies Alert
})

// Tells one alert, or the fold of the minute's alerts past the limit:
// toasts on the visible page, notifies from a background tab.
const tellAlert = Effect.fnUntraced(function* (
  alert: Alert,
  verdict: GateVerdict,
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
  const tone = alert.side === "bid" ? kToast.success : kToast.error
  yield* tone(alert.title, {
    description: alert.detail,
    icon: alert.side === "bid" ? IconArrowUp : IconArrowDown,
    duration: ALERT_MS,
    action: { label: "Open", onClick: () => open(alert) },
  })
})

/**
 * Tells this browser's alert rules' matches among a live page's book events
 * (spec apinrdw/kumora#517, "Alerts"), once per browser from the page that
 * holds the alert lock (use-alert-owner.ts): a toast on the visible page, a
 * notification from a background tab. The page feeds it every message of
 * its viewer socket; only a delta's new events alert. A recorded day's page
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
  const owns = useAlertOwner(live)
  useEffect(() => {
    held.current = context
  }, [context])

  const navigate = useNavigate()
  const open = useCallback(
    (alert: Alert) =>
      void navigate({
        to: "/market-live",
        search: { code: alert.code, event: alert.key },
      }),
    [navigate]
  )
  const view = useCallback(() => {
    alertBell.set(true)
    void navigate({ to: "/order-book-radar" })
  }, [navigate])

  const tell = useCallback(
    (alert: Alert, verdict: GateVerdict) =>
      void clientRuntime.runFork(tellAlert(alert, verdict, open, view)),
    [open, view]
  )

  return useCallback(
    (message: ViewerDown) => {
      figures.apply(message)
      const today = Effect.runSync(wibDateAt(message.at))
      alertDay.set(today)
      if (message._tag !== "Delta" || message.bookEvents === undefined) return
      const rules = alertRules.get()
      if (rules.length === 0) return
      const now = DateTime.toEpochMillis(message.at)
      for (const event of message.bookEvents) {
        const matched = rules.some((rule) =>
          Effect.runSync(ruleMatches(rule, event, held.current))
        )
        if (!matched) continue
        const verdict = Effect.runSync(gate.admit(event, now))
        if (verdict._tag === "Cooled" || !owns.current) continue
        const alert = Effect.runSync(alertOf(event))
        alertHistory.set(
          Effect.runSync(withAlert(alertHistory.get(), alert, today))
        )
        tell(alert, verdict)
      }
    },
    [figures, tell, owns]
  )
}
