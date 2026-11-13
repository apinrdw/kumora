import type { WibDate } from "@workspace/relay"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { DateTime, Effect, Option } from "effect"
import { useEffect, useState } from "react"

import type { AjaibLock } from "../worker/ajaib-lock.ts"
import type { HistoryPosition } from "../worker/broker-codes/history.ts"
import { recentClosedDays } from "../worker/broker-codes/hours.ts"
import type { BrokerCodesProgress } from "../worker/broker-codes/run-queue.ts"
import {
  brokerCodesPausedChange,
  historyStore,
  isAjaibLockChange,
  isBrokerCodesProgressChange,
  isBrokerCodesRunChange,
  isHistoryChange,
  isThrottledChange,
  loadAjaibLock,
  loadBrokerCodesPaused,
  loadBrokerCodesProgress,
  loadBrokerCodesRun,
  loadSettings,
  loadThrottled,
  saveBrokerCodesPaused,
  saveBrokerCodesRun,
} from "../worker/settings.ts"
import {
  causeLabels,
  dayStatus,
  dayView,
  historyView,
  walkView,
} from "./broker-codes-view.ts"
import { optionsRuntime } from "./runtime.ts"

const RECENT_DAYS = 10

type DayRow = { day: WibDate } & Effect.Success<ReturnType<typeof dayView>>

const lockLabels: Record<
  Extract<AjaibLock, { state: "locked" }>["reason"],
  string
> = {
  "no-pin": "Ajaib locked: enter the PIN below, or unlock the Ajaib tab.",
  refused: "Ajaib locked: Ajaib refused the PIN. Enter it again.",
  "not-typed":
    "Ajaib locked: the PIN could not be typed. Unlock the Ajaib tab.",
}

const wibClock = (epochMs: number) =>
  new Date(epochMs).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
  })

// The last 10 trading days, from Production's status, each with whether
// the extra target's copy is behind.
const loadDays = Effect.gen(function* () {
  const settings = yield* loadSettings
  const days = yield* recentClosedDays(yield* DateTime.now, RECENT_DAYS)
  const production = {
    origin: __PRODUCTION_DASHBOARD__,
    token: settings.productionToken,
  }
  const extra = Option.filter(
    Option.fromNullOr(settings.extra),
    ({ token }) => token !== ""
  )
  return yield* Effect.forEach(
    days,
    (day) =>
      Effect.gen(function* () {
        const leading =
          production.token === ""
            ? Option.none()
            : yield* dayStatus(production, day)
        const copy = Option.isSome(extra)
          ? yield* dayStatus(extra.value, day)
          : Option.none()
        return { day, ...(yield* dayView(leading, copy)) } satisfies DayRow
      }),
    { concurrency: "unbounded" }
  )
})

// The worker's broker codes walks: what runs now and why it waits, the
// last 10 days, the History walk, Run now and Pause/Resume.
export function BrokerCodesCard() {
  const [progress, setProgress] = useState<Option.Option<BrokerCodesProgress>>(
    Option.none()
  )
  const [paused, setPaused] = useState(false)
  const [asked, setAsked] = useState(false)
  const [lock, setLock] = useState<Option.Option<AjaibLock>>(Option.none())
  const [throttled, setThrottled] = useState<
    ReadonlyArray<[feed: string, until: number]>
  >([])
  const [history, setHistory] = useState<Option.Option<HistoryPosition>>(
    Option.none()
  )
  const [days, setDays] = useState<ReadonlyArray<DayRow>>()

  useEffect(() => {
    const run = <A,>(effect: Effect.Effect<A>, then: (value: A) => void) =>
      void optionsRuntime.runPromise(effect).then(then)
    // The days are asked again when the queue moves to another walk, day
    // or state.
    let moved: string | undefined
    const refreshProgress = () =>
      run(loadBrokerCodesProgress, (loaded) => {
        setProgress(loaded)
        const each = Option.getOrUndefined(loaded)
        const key =
          each?.state === "walking"
            ? `${each.walk} ${each.day} ${each.feed}`
            : (each?.state ?? "")
        if (key === moved) return
        moved = key
        run(loadDays, setDays)
      })
    const refreshPaused = () => run(loadBrokerCodesPaused, setPaused)
    const refreshRun = () =>
      run(loadBrokerCodesRun, (loaded) =>
        setAsked(Option.contains(loaded, "asked"))
      )
    const refreshLock = () => run(loadAjaibLock, setLock)
    // A throttle shows until it ends.
    let throttleEnds: ReturnType<typeof setTimeout> | undefined
    const refreshThrottled = () =>
      run(loadThrottled, (loaded) => {
        const now = Date.now()
        const active = Object.entries(loaded).filter(
          (entry): entry is [string, number] =>
            entry[1] !== undefined && entry[1] > now
        )
        setThrottled(active)
        clearTimeout(throttleEnds)
        const ends = Math.min(...active.map(([, until]) => until))
        if (Number.isFinite(ends))
          throttleEnds = setTimeout(refreshThrottled, ends - now)
      })
    const refreshHistory = () => run(historyStore.load, setHistory)
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (Effect.runSync(isBrokerCodesProgressChange(changes, area)))
        refreshProgress()
      if (Option.isSome(Effect.runSync(brokerCodesPausedChange(changes, area))))
        refreshPaused()
      if (Effect.runSync(isBrokerCodesRunChange(changes, area))) refreshRun()
      if (Effect.runSync(isAjaibLockChange(changes, area))) refreshLock()
      if (Effect.runSync(isThrottledChange(changes, area))) refreshThrottled()
      if (Effect.runSync(isHistoryChange(changes, area))) refreshHistory()
    }
    refreshProgress()
    refreshPaused()
    refreshRun()
    refreshLock()
    refreshThrottled()
    refreshHistory()
    chrome.storage.onChanged.addListener(onChanged)
    return () => {
      clearTimeout(throttleEnds)
      chrome.storage.onChanged.removeListener(onChanged)
    }
  }, [])

  const walking = Option.getOrUndefined(progress)
  const walk =
    walking?.state === "walking" ? Effect.runSync(walkView(walking)) : undefined
  const historyLine = Effect.runSync(historyView(history, progress))
  const causes = [
    ...(walking?.state === "paused" ? [causeLabels[walking.cause]] : []),
    // The switch is on before the worker has stopped the walk.
    ...(paused && !(walking?.state === "paused" && walking.cause === "paused")
      ? [causeLabels.paused]
      : []),
    ...Option.match(lock, {
      onNone: () => [],
      onSome: (each) =>
        each.state === "locked" ? [lockLabels[each.reason]] : [],
    }),
    ...throttled.map(
      ([feed, until]) => `${feed} throttled until ${wibClock(until)} WIB.`
    ),
  ]

  const runNow = () =>
    void optionsRuntime.runPromise(saveBrokerCodesRun("asked"))
  const switchPause = () =>
    void optionsRuntime.runPromise(saveBrokerCodesPaused(!paused))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Broker codes</CardTitle>
        <CardDescription>
          Each trading day's buyer and seller codes, walked after the close from
          the broker tabs and sent to Production.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1 text-sm">
          <p>
            Walking:{" "}
            <output aria-label="Broker codes walk">
              {walk?.walk ?? "Nothing"}
            </output>
          </p>
          {walk !== undefined && walk.trades !== "" && (
            <p>
              <output aria-label="Broker codes trades">{walk.trades}</output>
              {walk.pace !== "" && (
                <>
                  {", "}
                  <output aria-label="Broker codes pace">{walk.pace}</output>
                </>
              )}
              {walk.left !== "" && (
                <>
                  {", "}
                  <output aria-label="Broker codes time left">
                    {walk.left}
                  </output>
                </>
              )}
            </p>
          )}
        </div>
        <ul
          aria-label="Broker codes pause causes"
          className="grid gap-1 text-sm"
        >
          {causes.map((cause) => (
            <li key={cause}>{cause}</li>
          ))}
        </ul>
        <table aria-label="Last 10 trading days" className="text-sm">
          <thead>
            <tr className="text-left">
              <th>Day</th>
              <th>Codes</th>
              <th>Site</th>
              <th>Cross-check</th>
              <th>Extra target</th>
            </tr>
          </thead>
          <tbody>
            {(days ?? []).map((row) => (
              <tr key={row.day} data-day={row.day}>
                <td>{row.day}</td>
                <td>{row.held}</td>
                <td>{row.sites}</td>
                <td>{row.crossCheck}</td>
                <td>{row.behind ? "Behind" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm">
          History walk: <output aria-label="History walk">{historyLine}</output>
        </p>
        <div className="flex items-center gap-4">
          <Button type="button" disabled={paused || asked} onClick={runNow}>
            Run now
          </Button>
          <Button type="button" variant="outline" onClick={switchPause}>
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
