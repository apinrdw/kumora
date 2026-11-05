import { redirect } from "@tanstack/react-router"
import {
  Cause,
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
} from "effect"

import { HttpError } from "./errors.ts"

// An app types its bindings by augmenting this interface with
// `env: Cloudflare.InferEnv<typeof Website>` (see apps/web/src/server/env.ts).
export interface Register {}

export type Env = Register extends { readonly env: infer E }
  ? E
  : Record<string, unknown>

export class WorkerEnv extends Context.Service<WorkerEnv, Env>()(
  "@workspace/server/WorkerEnv"
) {}

// Decision: the only module that reaches `cloudflare:workers`, and only lazily
// per request. Prerender runs every route module in Bun, where a top-level
// import of it fails. See apinrdw/kumora#23.
const workerEnvLive = Layer.effect(
  WorkerEnv,
  Effect.promise(() => import("cloudflare:workers")).pipe(
    Effect.map(({ env }) => env as Env)
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

export function makeRunServerEffect<R>({ isolate, workerEnv }: Bridge<R>) {
  const runtime = ManagedRuntime.make(isolate)
  return async function runServerEffect<A, E>(
    effect: Effect.Effect<A, E, R | WorkerEnv>
  ): Promise<A> {
    const outcome = await runtime.runPromise(
      effect.pipe(
        Effect.provide(workerEnv),
        Effect.matchCauseEffect({
          onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
          onFailure: (cause) => {
            const error = Cause.findErrorOption(cause)
            if (
              !Cause.hasDies(cause) &&
              Option.isSome(error) &&
              isHttpError(error.value)
            )
              return Effect.succeed({
                ok: false as const,
                response: toResponse(error.value),
              })
            return Effect.logError("Server effect failed", cause).pipe(
              Effect.as({
                ok: false as const,
                response: json("InternalServerError", "", 500),
              })
            )
          },
        })
      )
    )
    if (outcome.ok) return outcome.value
    throw outcome.response
  }
}

export const runServerEffect = makeRunServerEffect({
  isolate: Layer.empty,
  workerEnv: workerEnvLive,
})
