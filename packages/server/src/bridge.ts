import { redirect } from "@tanstack/react-router"
import {
  Cause,
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Result,
  Schema,
} from "effect"

import { HttpError } from "./errors.ts"

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

// Keeps the isolate alive for a promise the response doesn't wait on, such as
// a mail send.
export class WaitUntil extends Context.Service<
  WaitUntil,
  { readonly waitUntil: (promise: Promise<unknown>) => void }
>()("@workspace/server/WaitUntil") {}

export const waitUntilLive = Layer.effect(
  WaitUntil,
  Effect.promise(() => import("cloudflare:workers")).pipe(
    Effect.map(({ waitUntil }) => WaitUntil.of({ waitUntil }))
  )
)

const isHttpError = Schema.is(HttpError)

const respond: {
  readonly [K in HttpError["_tag"]]: (
    error: Extract<HttpError, { readonly _tag: K }>
  ) => Response
} = {
  NotFound: (e) => json(e._tag, e.message, 404),
  BadRequest: (e) => json(e._tag, e.message, 400),
  Forbidden: (e) => json(e._tag, e.message, 403),
  Conflict: (e) => json(e._tag, e.message, 409),
  Unauthorized: (e) => redirect({ href: e.redirectTo }),
}

const json = (error: string, message: string, status: number) =>
  Response.json({ error, message }, { status })

const toResponse = (error: HttpError): Response =>
  (respond[error._tag] as (e: HttpError) => Response)(error)

export interface Bridge<R> {
  // Per-isolate services. The layer does no I/O and cannot fail.
  readonly isolate: Layer.Layer<R>
  readonly workerEnv: Layer.Layer<WorkerEnv>
}

type Settled<A, R = never> = Effect.Effect<
  Result.Result<A, HttpError | Response>,
  never,
  R
>

// Runs a program to its value, or to the HTTP error or bare 500 it ends in.
// Any failure outside the closed set, and any defect, is logged here.
const settle =
  ({ workerEnv }: Pick<Bridge<unknown>, "workerEnv">) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | WorkerEnv>): Settled<A, R> =>
    effect.pipe(
      Effect.provide(workerEnv),
      Effect.matchCauseEffect({
        onSuccess: (value): Settled<A> => Effect.succeed(Result.succeed(value)),
        onFailure: (cause): Settled<A> => {
          const errors = cause.reasons
            .filter(Cause.isFailReason)
            .map((reason) => reason.error)
          if (
            !Cause.hasDies(cause) &&
            errors.every(isHttpError) &&
            errors[0] !== undefined
          )
            return Effect.succeed(Result.fail(errors[0]))
          return Effect.logError("Server effect failed", cause).pipe(
            Effect.as(Result.fail(json("InternalServerError", "", 500)))
          )
        },
      })
    )

export function makeRunServerEffect<R>(bridge: Bridge<R>) {
  const runtime = ManagedRuntime.make(bridge.isolate)
  const run = settle(bridge)
  return async function runServerEffect<A, E>(
    effect: Effect.Effect<A, E, R | WorkerEnv>
  ): Promise<A> {
    const result = await runtime.runPromise(run(effect))
    if (Result.isSuccess(result)) return result.success
    throw result.failure instanceof Response
      ? result.failure
      : toResponse(result.failure)
  }
}

// Decision: a second runner for code that answers an HTTP error differently
// per surface (the dashboard's Worker entry: socket close 4401, 401 JSON, 403
// on ingest). It hands back the HTTP error, or the bare 500 Response for
// anything else, instead of throwing. See apinrdw/kumora#81.
export function makeRunServerEffectResult<R>(bridge: Bridge<R>) {
  const runtime = ManagedRuntime.make(bridge.isolate)
  const run = settle(bridge)
  return function runServerEffectResult<A, E>(
    effect: Effect.Effect<A, E, R | WorkerEnv>
  ): Promise<Result.Result<A, HttpError | Response>> {
    return runtime.runPromise(run(effect))
  }
}

export const runServerEffect = makeRunServerEffect({
  isolate: Layer.empty,
  workerEnv: workerEnvLive,
})

export const runServerEffectResult = makeRunServerEffectResult({
  isolate: Layer.empty,
  workerEnv: workerEnvLive,
})
