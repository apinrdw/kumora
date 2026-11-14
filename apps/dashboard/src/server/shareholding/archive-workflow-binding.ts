// ArchiveWorkflow over the SHAREHOLDING_ARCHIVE binding. Kept apart from
// archive-workflow.ts, so a test never loads it.
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer } from "effect"

import {
  ArchiveWorkflow,
  type CreateRun,
  DuplicateRunId,
  type InstanceStatus,
  type RunStatus,
  WorkflowError,
} from "./archive-workflow.ts"

// The binding's members this layer uses. The admin page's server functions
// provide this layer, so the tests' typecheck, which has no Workers types,
// reaches this module through the route tree: the Workflow binding meets this
// shape under Workers types, and its type checks against it without them.
interface WorkflowBinding {
  readonly create: (options: CreateRun) => Promise<unknown>
  readonly get: (id: string) => Promise<{
    readonly status: () => Promise<{
      readonly status: RunStatus
      readonly error?: { readonly message: string }
    }>
  }>
}

// The binding throws plain Errors; the runtime names the case in the message,
// as `(instance.already_exists) …` and `instance.not_found`.
const mentions = (cause: unknown, code: string) =>
  cause instanceof Error && cause.message.includes(code)

export const archiveWorkflowBinding = Layer.effect(
  ArchiveWorkflow,
  Effect.gen(function* () {
    const workflow: WorkflowBinding = (yield* WorkerEnv).SHAREHOLDING_ARCHIVE
    return ArchiveWorkflow.of({
      create: (options) =>
        Effect.tryPromise({
          try: () => workflow.create(options),
          catch: (cause) =>
            mentions(cause, "instance.already_exists")
              ? new DuplicateRunId({ id: options.id })
              : new WorkflowError({
                  operation: "create",
                  id: options.id,
                  cause,
                }),
        }).pipe(Effect.asVoid),
      status: (id) =>
        Effect.tryPromise({
          try: (): Promise<InstanceStatus | undefined> =>
            workflow
              .get(id)
              .then((instance) => instance.status())
              .then(({ status, error }) => ({
                status,
                error: error?.message ?? null,
              })),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            mentions(cause, "instance.not_found")
              ? Effect.succeed(undefined)
              : Effect.fail(
                  new WorkflowError({ operation: "status", id, cause })
                )
          )
        ),
    })
  })
)
