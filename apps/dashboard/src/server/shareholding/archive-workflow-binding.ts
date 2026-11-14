// ArchiveWorkflow over the SHAREHOLDING_ARCHIVE binding. Kept apart from
// archive-workflow.ts: the tests' typecheck has no Workers types, so it never
// imports this module.
import { WorkerEnv } from "@workspace/server"
import { Effect, Layer } from "effect"

import {
  ArchiveWorkflow,
  DuplicateRunId,
  type RunStatus,
  WorkflowError,
} from "./archive-workflow.ts"

// The binding throws plain Errors; the runtime names the case in the message,
// as `(instance.already_exists) …` and `instance.not_found`.
const mentions = (cause: unknown, code: string) =>
  cause instanceof Error && cause.message.includes(code)

export const archiveWorkflowBinding = Layer.effect(
  ArchiveWorkflow,
  Effect.gen(function* () {
    const workflow = (yield* WorkerEnv).SHAREHOLDING_ARCHIVE
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
          try: (): Promise<RunStatus | undefined> =>
            workflow
              .get(id)
              .then((instance) => instance.status())
              .then(({ status }) => status),
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
