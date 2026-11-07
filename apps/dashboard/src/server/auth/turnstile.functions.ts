// The Turnstile site key for the forms that send mail. It is public, but it
// differs per stage (alchemy.run.ts), so the page reads it from the Worker's
// env instead of the bundle.
import { createServerFn } from "@tanstack/react-start"
import { WorkerEnv, runServerEffect } from "@workspace/server"
import { Effect } from "effect"

export const turnstileSiteKeyFn = createServerFn({ method: "GET" }).handler(
  () =>
    runServerEffect(
      Effect.gen(function* () {
        return (yield* WorkerEnv).TURNSTILE_SITE_KEY
      })
    )
)
