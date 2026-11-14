// The archive run Workflow (SHAREHOLDING_ARCHIVE), as the code that starts
// and watches runs uses it. archive-workflow-binding.ts adapts the binding;
// tests provide an in-memory one.
import { Context, type Effect, Schema } from "effect"

import type { RETENTION } from "./retention.ts"
import { type ArchiveParams, ArchiveRunId } from "./run-result.ts"

export class DuplicateRunId extends Schema.TaggedError<DuplicateRunId>()(
  "DuplicateRunId",
  { id: ArchiveRunId }
) {}

export class WorkflowError extends Schema.TaggedError<WorkflowError>()(
  "WorkflowError",
  { operation: Schema.String, id: ArchiveRunId, cause: Schema.Defect() }
) {}

// A Workflow instance's status, as `status()` reports it.
export const RunStatus = Schema.Literals([
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
  readonly params: ArchiveParams
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
>()("dashboard/shareholding/ArchiveWorkflow") {}
