// An in-memory archive Workflow binding. `instances` holds every instance
// created, with what `create` was given; a test sets an instance's status.
// A second `create` with a used id fails the way the runtime does. `onCreate`
// runs inside `create`, as an instance that runs before `create` returns;
// `refuseCreate` fails every `create` with a WorkflowError.
import { Effect, Layer } from "effect"

import {
  ArchiveWorkflow,
  type CreateRun,
  DuplicateRunId,
  type RunStatus,
  WorkflowError,
} from "@/server/archive/workflow"

export interface FakeInstance {
  readonly options: CreateRun
  status: RunStatus
  error?: string
}

export interface FakeWorkflow {
  readonly instances: Map<string, FakeInstance>
  onCreate: ((id: string) => void) | undefined
  refuseCreate: boolean
  readonly layer: Layer.Layer<ArchiveWorkflow>
}

export const fakeWorkflow = (): FakeWorkflow => {
  const instances = new Map<string, FakeInstance>()
  const workflow: FakeWorkflow = {
    instances,
    onCreate: undefined,
    refuseCreate: false,
    layer: Layer.succeed(
      ArchiveWorkflow,
      ArchiveWorkflow.of({
        create: (options) =>
          workflow.refuseCreate
            ? Effect.fail(
                new WorkflowError({
                  operation: "create",
                  id: options.id,
                  cause: new Error("Workflows is unavailable"),
                })
              )
            : instances.has(options.id)
              ? Effect.fail(new DuplicateRunId({ id: options.id }))
              : Effect.sync(() => {
                  instances.set(options.id, { options, status: "queued" })
                  workflow.onCreate?.(options.id)
                }),
        status: (id) =>
          Effect.sync(() => {
            const instance = instances.get(id)
            return instance === undefined
              ? undefined
              : { status: instance.status, error: instance.error ?? null }
          }),
      })
    ),
  }
  return workflow
}
