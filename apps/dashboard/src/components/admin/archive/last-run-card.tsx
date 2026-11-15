// An archive's last run card and its run button. The archive passes in what
// is its own: the card's title, its counts, its partial-run details and its
// actions.
import { IconPlayerPlay, type TablerIcon } from "@tabler/icons-react"
import { useHydrated } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { loadServerFn } from "@workspace/server/loader"
import { Effect, Exit } from "effect"
import { type ReactNode, useState } from "react"

import {
  OutcomeLine,
  useAccountAction,
  type Outcome,
} from "@/components/account/account-section"
import { KBadge, KButton, type KButtonVariant, KDialog } from "@/components/k"
import { dateTime, duration } from "@/lib/format"
import type { RunBase } from "@/server/archive/run"
import type { RunView } from "@/server/archive/run-view"

import { ArchiveCard, OUTCOME } from "./archive-card"

const IN_PROGRESS = "A run is in progress"

/** What a button asks before it starts a run. */
interface RunConfirm {
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
}

/**
 * A button that starts a run with `start`, a server function, disabled while
 * a run is in progress. A Conflict from the server reads as a run in
 * progress. With `confirm`, it asks first. `note` says beside it that a run
 * is in progress; a second button beside the first leaves it to the first.
 */
export function RunArchiveButton({
  inProgress,
  start,
  icon = IconPlayerPlay,
  variant = "primary",
  confirm,
  note = true,
  children,
}: {
  inProgress: boolean
  start: () => Promise<{ readonly id: string }>
  icon?: TablerIcon
  variant?: KButtonVariant
  confirm?: RunConfirm
  note?: boolean
  children: ReactNode
}) {
  const hydrated = useHydrated()
  const [asking, setAsking] = useState(false)
  const { pending, outcome, run } = useAccountAction()
  const started: Effect.Effect<Outcome> = Effect.map(
    Effect.exit(loadServerFn(start)),
    (exit) =>
      Exit.match(exit, {
        onSuccess: ({ id }) => ({ _tag: "Done", message: `Started ${id}.` }),
        onFailure: (cause) => ({
          _tag: "Failed",
          message: cause.reasons.some(
            (reason) =>
              reason._tag === "Fail" && reason.error._tag === "Conflict"
          )
            ? `${IN_PROGRESS}.`
            : "Couldn't start a run. Try again.",
        }),
      })
  )
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-3">
        {note && inProgress && (
          <span className="text-[13px] text-muted-foreground">
            {IN_PROGRESS}
          </span>
        )}
        <KButton
          icon={icon}
          variant={variant}
          disabled={!hydrated || inProgress}
          loading={pending}
          title={inProgress ? IN_PROGRESS : undefined}
          onClick={() =>
            confirm === undefined
              ? clientRuntime.runFork(run(started))
              : setAsking(true)
          }
        >
          {children}
        </KButton>
      </div>
      <OutcomeLine outcome={outcome} />
      {confirm !== undefined && (
        <KDialog
          open={asking}
          onOpenChange={setAsking}
          kind="warning"
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.confirmLabel}
          cancelLabel="Cancel"
          onConfirm={() => {
            setAsking(false)
            clientRuntime.runFork(run(started))
          }}
        />
      )}
    </div>
  )
}

function Schedule({ times, nextRun }: ArchiveSchedule) {
  return (
    <p className="text-xs text-muted-foreground">
      Production runs at {times}. Next: {Effect.runSync(dateTime(nextRun))}.
    </p>
  )
}

function Stat({ value, label }: RunStat) {
  return (
    <div className="flex flex-col-reverse gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num text-xl font-semibold">{value}</dd>
    </div>
  )
}

function Failed({ error }: { error: string | null }) {
  return (
    <div
      role="alert"
      className="border-down bg-elevated rounded-xs border-l-[3px] px-3 py-2 text-[13px] [overflow-wrap:anywhere]"
    >
      <p>
        <b>Run failed:</b> {error ?? "no error was recorded"}
      </p>
      <p>The next run will try again.</p>
    </div>
  )
}

// The counts every archive's run shows first.
export const archiveRunStats = (result: {
  readonly reportsAdded: number
  readonly newVersions: number
  readonly reportsChecked: number
  readonly notStored: ReadonlyArray<string>
}): Array<RunStat> => [
  { value: result.reportsAdded, label: "Reports added" },
  { value: result.newVersions, label: "New versions" },
  { value: result.reportsChecked, label: "Reports checked" },
  { value: result.notStored.length, label: "Not stored" },
]

export interface RunStat {
  readonly label: string
  readonly value: number
}

export interface ArchiveSchedule {
  // When Production's cron runs, as "13:00 and 20:00 WIB".
  readonly times: string
  // An ISO instant.
  readonly nextRun: string
}

/**
 * An archive's last run, or the empty state before any, with its actions.
 * `stats` and `details` describe the last run: `details` shows below the
 * counts unless the run failed, when its error shows instead.
 */
export function ArchiveLastRunCard({
  title,
  emptyMessage,
  lastRun,
  now,
  stats,
  details,
  actions,
  schedule,
}: {
  title: ReactNode
  emptyMessage: string
  lastRun: RunView<RunBase> | undefined
  // When the page read the run, for a running run's time so far.
  now: string
  stats: ReadonlyArray<RunStat>
  details: ReactNode
  actions: ReactNode
  schedule: ArchiveSchedule
}) {
  if (lastRun === undefined)
    return (
      <ArchiveCard title={title} aside={actions}>
        <p className="text-[13px] text-muted-foreground">{emptyMessage}</p>
        <Schedule {...schedule} />
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
          {title}
          <KBadge tone={outcome.tone}>{outcome.label}</KBadge>
        </>
      }
      aside={actions}
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
        {stats.map((stat) => (
          <Stat key={stat.label} {...stat} />
        ))}
      </dl>
      {result.outcome === "failed" ? <Failed error={result.error} /> : details}
      <Schedule {...schedule} />
    </ArchiveCard>
  )
}
