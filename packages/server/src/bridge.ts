import { defaultParseSearch, redirect } from "@tanstack/react-router"
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

// Decision: only the bridge and workflow.ts import cloudflare:workers
// (packages/server/docs/adr/0001-only-the-bridge-and-the-workflow-runner-import-cloudflare-workers.md)
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
  Unauthorized: (e) => Effect.map(routerRedirect(e.redirectTo), redirect),
}

// An `href` would reach the Location header as is. The search is read with
// the router's own parser, so a typed value is written back as it was.
// Decision: `redirectTo` is a router path, so the router adds its basepath
// (docs/adr/0020-the-dashboard-is-served-under-dashboard-on-every-stage.md)
const routerRedirect = Effect.fnUntraced(function* (path: string) {
  const url = new URL(path, "http://router.invalid")
  return { to: url.pathname, search: defaultParseSearch(url.search) }
})

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

// Decision: runServerEffectResult hands back the HTTP error instead of throwing
// (packages/server/docs/adr/0002-a-second-runner-hands-back-the-http-error.md)
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
