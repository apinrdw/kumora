import { Effect, Schema } from "effect"

// A Workflow step that still failed after the step's own retries. Only its
// name and message survive: the runtime keeps no more of a step's error.
export class StepFailed extends Schema.TaggedError<StepFailed>()("StepFailed", {
  step: Schema.String,
  message: Schema.String,
}) {}

// A step failure no retry can fix, such as a file that's gone. The Workflow
// runner throws it as `NonRetryableError`, so the runtime skips the step's
// retries.
export class NonRetryable extends Schema.TaggedError<NonRetryable>()(
  "NonRetryable",
  { message: Schema.String }
) {}

// The most bytes a step's result may take: Cloudflare's limit on a non-stream
// step result, 1 MiB. A step whose result could outgrow it bounds its input.
export const STEP_RESULT_BYTES = 2 ** 20

// The most characters a step's name may take: Cloudflare's limit
// (repos/alchemy, cloudflare-runtime's workflows-shared/lib/validators.ts).
export const MAX_STEP_NAME_LENGTH = 256

// The bytes `value` takes as JSON, as a step result is measured here.
export const jsonBytes = (value: unknown) =>
  Effect.sync(() => new TextEncoder().encode(JSON.stringify(value)).length)

// The steps of one Workflow run, as Effects. `do` runs `effect` as a durable
// step named `name`: the runtime replays a finished step's result instead of
// running it again, so the result must be plain JSON, and the effect must
// not rely on anything outside it. The Workflow runner (./workflow.ts)
// provides `R` to each step; a test provides it in-process.
export interface WorkflowSteps<R> {
  readonly do: <A, E>(
    name: string,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, StepFailed>
}
