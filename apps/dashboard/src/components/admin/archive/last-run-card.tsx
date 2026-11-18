// An archive's last run card and its run button. The archive passes in what
// is its own: the card's title, its counts, its partial-run details and its
// actions.
import {
  IconAlertOctagon,
  IconClock,
  IconPlayerPlay,
  type TablerIcon,
} from "@tabler/icons-react"
import { useHydrated } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { loadServerFn } from "@workspace/server/loader"
import { cn } from "@workspace/ui/lib/utils"
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
          <span className="text-secondary-text text-[13px]">{IN_PROGRESS}</span>
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

// The card's last line: when Production's cron runs.
function Schedule({ times, nextRun }: ArchiveSchedule) {
  return (
    <p className="text-secondary-text flex items-center gap-2 text-[13px] leading-5">
      <IconClock aria-hidden className="size-4 shrink-0" stroke={1.75} />
      <span>
        Production runs at {times}. Next: {Effect.runSync(dateTime(nextRun))}.
      </span>
    </p>
  )
}

// One cell of the counts band. A zero recedes; a problem count above zero
// reads in the warning color.
function Stat({ value, label, problem = false }: RunStat) {
  return (
    <div className="flex flex-col-reverse justify-end gap-1 sm:px-4 sm:first:pl-0">
      <dt className="text-secondary-text text-xs leading-4">{label}</dt>
      <dd
        className={cn(
          "font-data text-xl leading-7 font-semibold tabular-nums",
          value === 0 ? "text-muted-foreground" : problem && "text-warning"
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function Failed({ error }: { error: string | null }) {
  return (
    <div
      role="alert"
      className="border-down/40 bg-down/10 flex gap-3 rounded-sm border px-4 py-3 text-sm leading-5 [overflow-wrap:anywhere]"
    >
      <IconAlertOctagon
        aria-hidden
        className="text-down mt-0.5 size-4 shrink-0"
        stroke={1.75}
      />
      <div className="flex flex-col gap-1">
        <p>
          <b className="font-semibold">Run failed:</b>{" "}
          {error ?? "no error was recorded"}
        </p>
        <p className="text-secondary-text">The next run will try again.</p>
      </div>
    </div>
  )
}

// The counts every archive's run shows first.
export const archiveRunStats = (result: {
  readonly reportsAdded: number
  readonly newVersions: number
  readonly reportsChecked: number
  readonly notStored: ReadonlyArray<string>
}): Effect.Effect<Array<RunStat>> =>
  Effect.succeed([
    { value: result.reportsAdded, label: "Reports added" },
    { value: result.newVersions, label: "New versions" },
    { value: result.reportsChecked, label: "Reports checked" },
    { value: result.notStored.length, label: "Not stored", problem: true },
  ])

export interface RunStat {
  readonly label: string
  readonly value: number
  // A count that is something to fix when above zero.
  readonly problem?: boolean
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
 * counts, after the error of a run that failed.
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
        <p className="text-secondary-text border-strong rounded-sm border border-dashed px-4 py-6 text-center text-sm leading-5 text-pretty">
          {emptyMessage}
        </p>
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
      <p className="text-secondary-text flex flex-wrap gap-x-2 gap-y-1 text-[13px] leading-5">
        <span>Started {Effect.runSync(dateTime(result.startedAt))}</span>
        {result.finishedAt !== null && (
          <span>
            · took{" "}
            {Effect.runSync(duration(Date.parse(result.finishedAt) - since))}
          </span>
        )}
        {running && (
          <span className="inline-flex items-center gap-1.5">
            ·
            <span
              aria-hidden
              className="bg-info size-2 rounded-full motion-safe:animate-pulse"
            />
            running for {Effect.runSync(duration(Date.parse(now) - since))}
          </span>
        )}
        <span>
          · <span className="font-data text-xs">{result.id}</span>
        </span>
        {running && workflowStatus !== null && (
          <span>· Workflow {workflowStatus}</span>
        )}
      </p>
      {/* Ruled above and below, one column per count from sm, divided by
          hairlines; two columns on a phone. Not a box, so a count is never
          three boxes deep. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 border-y border-border py-4 sm:auto-cols-fr sm:grid-flow-col sm:grid-cols-none sm:gap-x-0 sm:divide-x sm:divide-border">
        {stats.map((stat) => (
          <Stat key={stat.label} {...stat} />
        ))}
      </dl>
      {result.outcome === "failed" && <Failed error={result.error} />}
      {details}
      <Schedule {...schedule} />
    </ArchiveCard>
  )
}
