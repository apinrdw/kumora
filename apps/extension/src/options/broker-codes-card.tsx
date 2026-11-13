import type { Feed, WibDate } from "@workspace/relay"
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

import { recentClosedDays } from "../worker/broker-codes/hours.ts"
import type { BrokerCodesProgress } from "../worker/broker-codes/run-queue.ts"
import {
  DashboardOrigin,
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
  causesView,
  dayStatus,
  dayView,
  historyView,
  walkView,
} from "./broker-codes-view.ts"
import { optionsRuntime } from "./runtime.ts"

const RECENT_DAYS = 10

type DayRow = { day: WibDate } & Effect.Success<ReturnType<typeof dayView>>

type StorageChange = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string
) => Effect.Effect<boolean>

const isPausedChange: StorageChange = (changes, area) =>
  Effect.map(brokerCodesPausedChange(changes, area), Option.isSome)

const loadAsked = Effect.map(loadBrokerCodesRun, (run) =>
  Option.contains(run, "asked")
)

// The last 10 trading days, from Production's status, each with whether
// the extra target's copy is behind.
const loadDays = Effect.gen(function* () {
  const settings = yield* loadSettings
  const days = yield* recentClosedDays(yield* DateTime.now, RECENT_DAYS)
  const production = Option.some({
    origin: DashboardOrigin.make(__PRODUCTION_DASHBOARD__),
    token: settings.productionToken,
  }).pipe(Option.filter(({ token }) => token !== ""))
  const extra = Option.filter(
    Option.fromNullOr(settings.extra),
    ({ token }) => token !== ""
  )
  const statusFrom = (target: typeof extra, day: WibDate) =>
    Option.isSome(target)
      ? dayStatus(target.value, day)
      : Effect.succeed(Option.none())
  return yield* Effect.forEach(
    days,
    (day) =>
      Effect.gen(function* () {
        const view = yield* dayView(
          yield* statusFrom(production, day),
          yield* statusFrom(extra, day)
        )
        return { day, ...view } satisfies DayRow
      }),
    { concurrency: "unbounded" }
  )
})

// The days are asked again when the queue moves to another walk, day or
// state.
const progressKey = (progress: Option.Option<BrokerCodesProgress>) =>
  Effect.sync(() =>
    Option.match(progress, {
      onNone: () => "",
      onSome: (each) =>
        each.state === "walking"
          ? `${each.walk} ${each.day} ${each.feed}`
          : each.state,
    })
  )

// A stored value, loaded at once and again on each change to it.
function useStored<A>(
  load: Effect.Effect<A>,
  isChange: StorageChange,
  initial: A
) {
  const [value, setValue] = useState(initial)
  useEffect(() => {
    const refresh = () => void optionsRuntime.runPromise(load).then(setValue)
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (Effect.runSync(isChange(changes, area))) refresh()
    }
    refresh()
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [load, isChange])
  return value
}

// Now, moved on when the soonest of `ends` passes, so a throttle shows
// until it ends.
function useNowUntil(ends: ReadonlyArray<number>) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const soonest = Math.min(...ends.filter((end) => end > now))
    if (!Number.isFinite(soonest)) return
    const timer = setTimeout(() => setNow(Date.now()), soonest - now)
    return () => clearTimeout(timer)
  }, [ends, now])
  return now
}

function WalkLine({
  progress,
}: {
  progress: Option.Option<BrokerCodesProgress>
}) {
  const walking = Option.getOrUndefined(progress)
  const walk =
    walking?.state === "walking" ? Effect.runSync(walkView(walking)) : undefined
  const details = (
    [
      ["Broker codes trades", walk?.trades],
      ["Broker codes pace", walk?.pace],
      ["Broker codes time left", walk?.left],
    ] as const
  ).filter(([, text]) => text !== undefined && text !== "")
  return (
    <div className="grid gap-1 text-sm">
      <p>
        Walking:{" "}
        <output aria-label="Broker codes walk">
          {walk?.walk ?? "Nothing"}
        </output>
      </p>
      {details.length > 0 && (
        <p>
          {details.map(([label, text], at) => (
            <span key={label}>
              {at > 0 && ", "}
              <output aria-label={label}>{text}</output>
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

function PauseCauses({
  progress,
  paused,
}: {
  progress: Option.Option<BrokerCodesProgress>
  paused: boolean
}) {
  const lock = useStored(loadAjaibLock, isAjaibLockChange, Option.none())
  const stored = useStored(loadThrottled, isThrottledChange, {})
  const now = useNowUntil(
    Object.values(stored).filter((until) => until !== undefined)
  )
  const throttled = Object.entries(stored).filter(
    (entry): entry is [Feed, number] => entry[1] !== undefined && entry[1] > now
  )
  const causes = Effect.runSync(
    causesView({ progress, paused, lock, throttled })
  )
  return (
    <ul aria-label="Broker codes pause causes" className="grid gap-1 text-sm">
      {causes.map((cause) => (
        <li key={cause}>{cause}</li>
      ))}
    </ul>
  )
}

function RecentDays({
  progress,
}: {
  progress: Option.Option<BrokerCodesProgress>
}) {
  // The rows, and the progress they were asked for.
  const [{ rows: days }, setDays] = useState<{
    readonly asked: string
    readonly rows: ReadonlyArray<DayRow>
  }>({ asked: "", rows: [] })
  const key = Effect.runSync(progressKey(progress))
  useEffect(() => {
    void optionsRuntime
      .runPromise(loadDays)
      .then((rows) => setDays({ asked: key, rows }))
  }, [key])
  return (
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
        {days.map((row) => (
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
  )
}

function HistoryLine({
  progress,
}: {
  progress: Option.Option<BrokerCodesProgress>
}) {
  const history = useStored(historyStore.load, isHistoryChange, Option.none())
  return (
    <p className="text-sm">
      History walk:{" "}
      <output aria-label="History walk">
        {Effect.runSync(historyView(history, progress))}
      </output>
    </p>
  )
}

function Controls({ paused }: { paused: boolean }) {
  const asked = useStored(loadAsked, isBrokerCodesRunChange, false)
  const runNow = () =>
    void optionsRuntime.runPromise(saveBrokerCodesRun("asked"))
  const switchPause = () =>
    void optionsRuntime.runPromise(saveBrokerCodesPaused(!paused))
  return (
    <div className="flex items-center gap-4">
      <Button type="button" disabled={paused || asked} onClick={runNow}>
        Run now
      </Button>
      <Button type="button" variant="outline" onClick={switchPause}>
        {paused ? "Resume" : "Pause"}
      </Button>
    </div>
  )
}

// The worker's broker codes walks: what runs now and why it waits, the
// last 10 days, the History walk, Run now and Pause/Resume.
export function BrokerCodesCard() {
  const progress = useStored(
    loadBrokerCodesProgress,
    isBrokerCodesProgressChange,
    Option.none()
  )
  const paused = useStored(loadBrokerCodesPaused, isPausedChange, false)
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
        <WalkLine progress={progress} />
        <PauseCauses progress={progress} paused={paused} />
        <RecentDays progress={progress} />
        <HistoryLine progress={progress} />
        <Controls paused={paused} />
      </CardContent>
    </Card>
  )
}
