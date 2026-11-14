// An archive's run Workflow, as the code that starts and watches its runs
// uses it. Each archive has its own Workflow, which it provides as this
// service: workflow-binding.ts adapts a binding; tests provide an in-memory
// one.
import { Context, type Effect, Schema } from "effect"

import type { RETENTION } from "./retention.ts"
import { ArchiveRunId, type RunParams } from "./run.ts"

export class DuplicateRunId extends Schema.TaggedError<DuplicateRunId>()(
  "DuplicateRunId",
  { id: ArchiveRunId }
) {}

export class WorkflowError extends Schema.TaggedError<WorkflowError>()(
  "WorkflowError",
  { operation: Schema.String, id: ArchiveRunId, cause: Schema.Defect() }
) {}

// A Workflow instance's status, as `status()` reports it.
const RunStatus = Schema.Literals([
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "rollingBack",
  "unknown",
])
export type RunStatus = typeof RunStatus.Type

export interface InstanceStatus {
  readonly status: RunStatus
  // The instance's error message, once it has errored.
  readonly error: string | null
}

export interface CreateRun {
  readonly id: ArchiveRunId
  readonly params: RunParams
  readonly retention: typeof RETENTION
}

export class ArchiveWorkflow extends Context.Service<
  ArchiveWorkflow,
  {
    // Fails with DuplicateRunId while an instance with the id is retained.
    readonly create: (
      options: CreateRun
    ) => Effect.Effect<void, DuplicateRunId | WorkflowError>
    // Undefined when no instance has the id, for example past retention.
    readonly status: (
      id: ArchiveRunId
    ) => Effect.Effect<InstanceStatus | undefined, WorkflowError>
  }
>()("dashboard/archive/ArchiveWorkflow") {}
