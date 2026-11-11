// Runs a Market Live answer through the bridge's result runner (spec
// apinrdw/kumora#138, "The custom Worker entry and the gate"). Each surface
// maps its own HTTP errors to an answer first, so anything still failing is
// the runner's logged 500, or a bare 500. Decision: `respond` returns a
// Promise, not an Effect: it is the runner itself, which Cloudflare's
// callbacks (the Worker's `fetch`, the Durable Objects' methods) hand their
// Effect to.
import { runServerEffectResult, type WorkerEnv } from "@workspace/server"
import { Result, type Effect } from "effect"

export const respond = <E>(
  answer: Effect.Effect<Response, E, WorkerEnv>
): Promise<Response> =>
  runServerEffectResult(answer).then((settled) =>
    Result.isSuccess(settled)
      ? settled.success
      : settled.failure instanceof Response
        ? settled.failure
        : new Response(null, { status: 500 })
  )
