import { IconPlayerPlay } from "@tabler/icons-react"
import { useHydrated } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { loadServerFn } from "@workspace/server/loader"
import { Effect, Exit } from "effect"

import {
  OutcomeLine,
  useAccountAction,
  type Outcome,
} from "@/components/account/account-section"
import { KBadge, KButton } from "@/components/k"
import { count, dateTime, duration } from "@/lib/format"
import { runArchiveNowFn } from "@/server/admin/shareholding.functions"
import type { ArchiveRunResult } from "@/server/shareholding/run-result"
import type { RunView } from "@/server/shareholding/run-view"
import { ARCHIVE_TIMES_WIB } from "@/server/shareholding/schedule"

import { ArchiveCard, OUTCOME } from "./archive-card"

const IN_PROGRESS = "A run is in progress"

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

function Schedule({ nextRun }: { nextRun: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Production runs at {ARCHIVE_TIMES_WIB}. Next:{" "}
      {Effect.runSync(dateTime(nextRun))}.
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
            {Effect.runSync(
              count(
                result.notStored.length,
                "report could not be stored.",
                "reports could not be stored."
              )
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
            {Effect.runSync(
              count(
                result.other.length,
                "report of an unknown kind",
                "reports of an unknown kind"
              )
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
  now,
}: {
  lastRun: RunView | undefined
  nextRun: string
  // When the page read the run, for a running run's time so far.
  now: string
}) {
  const inProgress = lastRun?.inProgress ?? false
  if (lastRun === undefined)
    return (
      <ArchiveCard
        title="Last archive run"
        aside={<RunNow inProgress={inProgress} />}
      >
        <p className="text-[13px] text-muted-foreground">
          No archive run has happened yet.
        </p>
        <Schedule nextRun={nextRun} />
      </ArchiveCard>
    )
  const { result, workflowStatus } = lastRun
  const outcome = OUTCOME[result.outcome]
  const running = result.outcome === "running"
  const since = Date.parse(result.startedAt)
  return (
    <ArchiveCard
      title={
        <>
          Last archive run
          <KBadge tone={outcome.tone}>{outcome.label}</KBadge>
        </>
      }
      aside={<RunNow inProgress={inProgress} />}
    >
      <p className="flex flex-wrap gap-x-2 text-[13px] text-muted-foreground">
        <span>Started {Effect.runSync(dateTime(result.startedAt))}</span>
        {result.finishedAt !== null && (
          <span>
            · took{" "}
            {Effect.runSync(duration(Date.parse(result.finishedAt) - since))}
          </span>
        )}
        {running && (
          <span>
            · running for {Effect.runSync(duration(Date.parse(now) - since))}
          </span>
        )}
        <span>
          · <span className="font-mono text-xs">{result.id}</span>
        </span>
        {running && workflowStatus !== null && (
          <span>· Workflow {workflowStatus}</span>
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
    </ArchiveCard>
  )
}
