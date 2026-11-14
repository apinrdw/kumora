// An in-memory SHAREHOLDING_ARCHIVE binding. `instances` holds every instance
// created, with what `create` was given; a test sets an instance's status.
// A second `create` with a used id fails the way the runtime does.
import { Effect, Layer } from "effect"

import {
  ArchiveWorkflow,
  type CreateRun,
  DuplicateRunId,
  type RunStatus,
} from "@/server/shareholding/archive-workflow"

export interface FakeInstance {
  readonly options: CreateRun
  status: RunStatus
  error?: string
}

export interface FakeWorkflow {
  readonly instances: Map<string, FakeInstance>
  readonly layer: Layer.Layer<ArchiveWorkflow>
}

export const fakeWorkflow = (): FakeWorkflow => {
  const instances = new Map<string, FakeInstance>()
  return {
    instances,
    layer: Layer.succeed(
      ArchiveWorkflow,
      ArchiveWorkflow.of({
        create: (options) =>
          instances.has(options.id)
            ? Effect.fail(new DuplicateRunId({ id: options.id }))
            : Effect.sync(() => {
                instances.set(options.id, { options, status: "queued" })
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
}
