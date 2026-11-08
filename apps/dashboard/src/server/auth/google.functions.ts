import { createServerFn } from "@tanstack/react-start"
import { WorkerEnv, runServerEffect } from "@workspace/server"
import { Effect } from "effect"

import { googleClient } from "./google.ts"

/** Whether this stage offers Google sign-in: it bound a Google client. */
export const googleSignInFn = createServerFn({ method: "GET" }).handler(() =>
  runServerEffect(
    Effect.map(WorkerEnv, (env) => googleClient(env) !== undefined)
  )
)
