// ArchiveWorkflow over an archive's Workflow binding. Kept apart from
// workflow.ts, so a test never loads it.
import { WorkerEnv, type WorkerEnvShape } from "@workspace/server"
import { type Context, Effect, Layer } from "effect"

import {
  ArchiveWorkflow,
  type CreateRun,
  DuplicateRunId,
  type InstanceStatus,
  type RunStatus,
  WorkflowError,
} from "./workflow.ts"

// The binding's members this layer uses. The admin pages' server functions
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
  Effect.sync(() => cause instanceof Error && cause.message.includes(code))

// The archive Workflow over the binding `binding` picks from the Worker's
// env, such as `(env) => env.SHAREHOLDING_ARCHIVE`.
export const boundArchiveWorkflow = (
  binding: (env: WorkerEnvShape) => WorkflowBinding
) =>
  Layer.effect(
    ArchiveWorkflow,
    Effect.gen(function* () {
      const workflow = binding(yield* WorkerEnv)
      return ArchiveWorkflow.of({
        create: (options) =>
          Effect.tryPromise({
            try: () => workflow.create(options),
            catch: (cause) => cause,
          }).pipe(
            Effect.asVoid,
            Effect.catch(
              Effect.fnUntraced(function* (cause) {
                return yield* (yield* mentions(
                  cause,
                  "instance.already_exists"
                ))
                  ? new DuplicateRunId({ id: options.id })
                  : new WorkflowError({
                      operation: "create",
                      id: options.id,
                      cause,
                    })
              })
            )
          ),
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
            Effect.catch(
              Effect.fnUntraced(function* (cause) {
                if (yield* mentions(cause, "instance.not_found"))
                  return undefined
                return yield* new WorkflowError({
                  operation: "status",
                  id,
                  cause,
                })
              })
            )
          ),
      })
    })
  )

// The Workflow over `binding` as `service`, a run's own name for it, such as
// a parse run's (../holdings/parse-runs.ts), so one layer can hold several.
export const boundWorkflowAs = <Self>(
  service: Context.Key<Self, Context.Service.Shape<typeof ArchiveWorkflow>>,
  binding: (env: WorkerEnvShape) => WorkflowBinding
) =>
  Layer.effect(service, Effect.service(ArchiveWorkflow)).pipe(
    Layer.provide(boundArchiveWorkflow(binding))
  )
