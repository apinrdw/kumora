import { IconPlayerPlay } from "@tabler/icons-react"
import { useHydrated } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { loadServerFn } from "@workspace/server/loader"
import { cn } from "@workspace/ui/lib/utils"
import { Effect, Exit } from "effect"
import { useId, type ReactNode } from "react"

import {
  OutcomeLine,
  useAccountAction,
  type Outcome,
} from "@/components/account/account-section"
import { KBadge, KButton, kCard, type KBadgeTone } from "@/components/k"
import { dateTime } from "@/lib/format"
import { runArchiveNowFn } from "@/server/admin/shareholding.functions"
import type { LastRun } from "@/server/shareholding/start-run"
import type { ArchiveRunResult } from "@/server/shareholding/run-result"

const IN_PROGRESS = "A run is in progress"

export const OUTCOME = {
  running: { label: "Running", tone: "info" },
  complete: { label: "Complete", tone: "up" },
  partial: { label: "Partial", tone: "warning" },
  failed: { label: "Failed", tone: "down" },
} as const satisfies Record<
  ArchiveRunResult["outcome"],
  { label: string; tone: KBadgeTone }
>

export const wib = (iso: string) => Effect.runSync(dateTime(iso))

// 1 min 12 s; 34 s
const duration = (from: string, to: string) => {
  const seconds = Math.round((Date.parse(to) - Date.parse(from)) / 1000)
  const minutes = Math.floor(seconds / 60)
  return minutes === 0
    ? `${seconds} s`
    : `${minutes} min ${seconds - minutes * 60} s`
}

export const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`

const startRun: Effect.Effect<Outcome> = Effect.map(
  Effect.exit(loadServerFn(() => runArchiveNowFn())),
  (exit) =>
    Exit.match(exit, {
      onSuccess: ({ id }) => ({ _tag: "Done", message: `Started ${id}.` }),
      onFailure: (cause) => ({
        _tag: "Failed",
        message: cause.reasons.some(
          (reason) => reason._tag === "Fail" && reason.error._tag === "Conflict"
        )
          ? `${IN_PROGRESS}.`
          : "Couldn't start a run. Try again.",
      }),
    })
)

function RunNow({ inProgress }: { inProgress: boolean }) {
  const hydrated = useHydrated()
  const { pending, outcome, run } = useAccountAction()
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        {inProgress && (
          <span className="text-[13px] text-muted-foreground">
            {IN_PROGRESS}
          </span>
        )}
        <KButton
          icon={IconPlayerPlay}
          disabled={!hydrated || inProgress}
          loading={pending}
          title={inProgress ? IN_PROGRESS : undefined}
          onClick={() => clientRuntime.runFork(run(startRun))}
        >
          Run now
        </KButton>
      </div>
      <OutcomeLine outcome={outcome} />
    </div>
  )
}

export function Card({
  title,
  aside,
  children,
}: {
  title: ReactNode
  aside: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={cn(kCard, "flex flex-col gap-4")}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <h2
          id={id}
          className="flex items-center gap-3 text-[15px] font-semibold"
        >
          {title}
        </h2>
        {aside}
      </header>
      {children}
    </section>
  )
}

function Schedule({ nextRun }: { nextRun: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Production runs at 13:00 and 20:00 WIB. Next: {wib(nextRun)}.
    </p>
  )
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col-reverse gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num text-xl font-semibold">{value}</dd>
    </div>
  )
}

function Detail({ result }: { result: ArchiveRunResult }) {
  if (result.outcome === "failed")
    return (
      <div
        role="alert"
        className="border-down bg-elevated rounded-xs border-l-[3px] px-3 py-2 text-[13px] [overflow-wrap:anywhere]"
      >
        <p>
          <b>Run failed:</b> {result.error ?? "no error was recorded"}
        </p>
        <p>The next run will try again.</p>
      </div>
    )
  if (result.notStored.length === 0 && result.other.length === 0) return null
  return (
    <div className="border-warning bg-elevated flex flex-col gap-2 rounded-xs border-l-[3px] px-3 py-2 text-[13px]">
      {result.notStored.length > 0 && (
        <div>
          <b>
            {plural(
              result.notStored.length,
              "report could not be stored.",
              "reports could not be stored."
            )}
          </b>{" "}
          The next run retries {result.notStored.length === 1 ? "it" : "them"}.
          <ul aria-label="Not stored" className="mt-1 list-disc pl-5">
            {result.notStored.map((url) => (
              <li
                key={url}
                className="font-mono text-xs [overflow-wrap:anywhere]"
              >
                {url}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.other.length > 0 && (
        <div>
          <b>
            {plural(
              result.other.length,
              "report of an unknown kind",
              "reports of an unknown kind"
            )}
          </b>{" "}
          {result.other.length === 1 ? "was" : "were"} archived under{" "}
          <span className="font-mono text-xs">other</span>.
          <ul aria-label="Archived under other" className="mt-1 list-disc pl-5">
            {result.other.map(({ sourceUrl, description }) => (
              <li key={sourceUrl} className="[overflow-wrap:anywhere]">
                {description}{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  {sourceUrl}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** The last archive run, or the empty state before any, with Run now. */
export function LastRunCard({
  lastRun,
  nextRun,
}: {
  lastRun: LastRun | undefined
  nextRun: string
}) {
  const inProgress = lastRun?.inProgress ?? false
  if (lastRun === undefined)
    return (
      <Card title="Last archive run" aside={<RunNow inProgress={inProgress} />}>
        <p className="text-[13px] text-muted-foreground">
          No archive run has happened yet.
        </p>
        <Schedule nextRun={nextRun} />
      </Card>
    )
  const { result, live } = lastRun
  const outcome = OUTCOME[result.outcome]
  return (
    <Card
      title={
        <>
          Last archive run
          <KBadge tone={outcome.tone}>{outcome.label}</KBadge>
        </>
      }
      aside={<RunNow inProgress={inProgress} />}
    >
      <p className="flex flex-wrap gap-x-2 text-[13px] text-muted-foreground">
        <span>Started {wib(result.startedAt)}</span>
        {result.finishedAt !== null && (
          <span>· took {duration(result.startedAt, result.finishedAt)}</span>
        )}
        <span>
          · <span className="font-mono text-xs">{result.id}</span>
        </span>
        {result.outcome === "running" && live !== null && (
          <span>· Workflow {live}</span>
        )}
      </p>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-3">
        <Stat value={result.reportsAdded} label="Reports added" />
        <Stat value={result.newVersions} label="New versions" />
        <Stat value={result.reportsChecked} label="Reports checked" />
        <Stat value={result.notStored.length} label="Not stored" />
      </dl>
      <Detail result={result} />
      <Schedule nextRun={nextRun} />
    </Card>
  )
}
