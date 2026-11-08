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

type Settled<A> = Result.Result<A, HttpError | Response>

// Runs a program to its value, or to the HTTP error or bare 500 it ends in.
// Any failure outside the closed set, and any defect, is logged here.
const settle = <A, E, R>(
  workerEnv: Layer.Layer<WorkerEnv>,
  effect: Effect.Effect<A, E, R | WorkerEnv>
): Effect.Effect<Settled<A>, never, R> =>
  effect.pipe(
    Effect.provide(workerEnv),
    Effect.matchCauseEffect({
      onSuccess: (value): Effect.Effect<Settled<A>> =>
        Effect.succeed(Result.succeed(value)),
      onFailure: (cause): Effect.Effect<Settled<A>> => {
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
          Effect.andThen(json("InternalServerError", "", 500)),
          Effect.map((response) => Result.fail(response))
        )
      },
    })
  )

export function makeRunServerEffect<R>({ isolate, workerEnv }: Bridge<R>) {
  const runtime = ManagedRuntime.make(isolate)
  // runPromise rejects with the first failure's error as is, so failing with
  // the Response is how TanStack Start receives it thrown.
  return function runServerEffect<A, E>(
    effect: Effect.Effect<A, E, R | WorkerEnv>
  ): Promise<A> {
    return runtime.runPromise(
      settle(workerEnv, effect).pipe(
        Effect.flatMap((result) => {
          if (Result.isSuccess(result)) return Effect.succeed(result.success)
          if (result.failure instanceof Response)
            return Effect.fail(result.failure)
          return Effect.flatMap(toResponse(result.failure), Effect.fail)
        })
      )
    )
  }
}

// Decision: a second runner for code that answers an HTTP error differently
// per surface (the dashboard's Worker entry: socket close 4401, 401 JSON, 403
// on ingest). It hands back the HTTP error, or the bare 500 Response for
// anything else, instead of throwing. See apinrdw/kumora#81.
export function makeRunServerEffectResult<R>({
  isolate,
  workerEnv,
}: Bridge<R>) {
  const runtime = ManagedRuntime.make(isolate)
  return function runServerEffectResult<A, E>(
    effect: Effect.Effect<A, E, R | WorkerEnv>
  ): Promise<Settled<A>> {
    return runtime.runPromise(settle(workerEnv, effect))
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
