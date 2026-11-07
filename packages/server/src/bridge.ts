import { redirect } from "@tanstack/react-router"
import { Cause, Context, Effect, Layer, ManagedRuntime, Schema } from "effect"

import { ErrorBody, HttpError } from "./errors.ts"

// An app types its bindings by augmenting this interface with
// `env: Cloudflare.InferEnv<typeof Website>` (see apps/web/alchemy.run.ts).
export interface Register {}

export type WorkerEnvShape = Register extends { readonly env: infer E }
  ? E
  : Record<string, unknown>

export class WorkerEnv extends Context.Service<WorkerEnv, WorkerEnvShape>()(
  "@workspace/server/WorkerEnv"
) {}

// Decision: the only module that reaches `cloudflare:workers`, and only lazily
// per request. Prerender runs every route module in Bun, where a top-level
// import of it fails. See apinrdw/kumora#23.
const workerEnvLive = Layer.effect(
  WorkerEnv,
  Effect.promise(() => import("cloudflare:workers")).pipe(
    Effect.map(({ env }) => env as WorkerEnvShape)
  )
)

const isHttpError = Schema.is(HttpError)

const respond: {
  readonly [K in HttpError["_tag"]]: (
    error: Extract<HttpError, { readonly _tag: K }>
  ) => Effect.Effect<Response>
} = {
  NotFound: (e) => json(e._tag, e.message, 404),
  BadRequest: (e) => json(e._tag, e.message, 400),
  Forbidden: (e) => json(e._tag, e.message, 403),
  Conflict: (e) => json(e._tag, e.message, 409),
  Unauthorized: (e) => Effect.sync(() => redirect({ href: e.redirectTo })),
}

const json = Effect.fnUntraced(function* (
  error: string,
  message: string,
  status: number
) {
  return Response.json(ErrorBody.make({ error, message }), { status })
})

const toResponse = Effect.fnUntraced(function* (error: HttpError) {
  return yield* (
    respond[error._tag] as (e: HttpError) => Effect.Effect<Response>
  )(error)
})

export interface Bridge<R> {
  // Per-isolate services. The layer does no I/O and cannot fail.
  readonly isolate: Layer.Layer<R>
  readonly workerEnv: Layer.Layer<WorkerEnv>
}

export function makeRunServerEffect<R>({ isolate, workerEnv }: Bridge<R>) {
  const runtime = ManagedRuntime.make(isolate)
  // runPromise rejects with the first failure's error as is, so failing with
  // the Response is how TanStack Start receives it thrown.
  return function runServerEffect<A, E>(
    effect: Effect.Effect<A, E, R | WorkerEnv>
  ): Promise<A> {
    return runtime.runPromise(
      effect.pipe(
        Effect.provide(workerEnv),
        Effect.catchCause((cause) => {
          const errors = cause.reasons
            .filter(Cause.isFailReason)
            .map((reason) => reason.error)
          if (
            !Cause.hasDies(cause) &&
            errors.every(isHttpError) &&
            errors[0] !== undefined
          )
            return Effect.flatMap(toResponse(errors[0]), Effect.fail)
          return Effect.logError("Server effect failed", cause).pipe(
            Effect.andThen(json("InternalServerError", "", 500)),
            Effect.flatMap(Effect.fail)
          )
        })
      )
    )
  }
}

export const runServerEffect = makeRunServerEffect({
  isolate: Layer.empty,
  workerEnv: workerEnvLive,
})
