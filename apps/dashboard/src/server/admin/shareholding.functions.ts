import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { Effect, Layer } from "effect"

import { Auth } from "@/server/auth/auth"
import { archiveWorkflowBinding } from "@/server/shareholding/archive-workflow-binding"
import { archiveBucketR2 } from "@/server/shareholding/bucket-r2"

import { runArchiveNow, shareholdingArchivePage } from "./shareholding.ts"

const services = Layer.mergeAll(
  Auth.layer,
  archiveBucketR2,
  archiveWorkflowBinding
)

export const shareholdingArchiveFn = createServerFn({ method: "GET" }).handler(
  () =>
    runServerEffect(
      shareholdingArchivePage(getRequest().headers).pipe(
        Effect.provide(services)
      )
    )
)

export const runArchiveNowFn = createServerFn({ method: "POST" }).handler(() =>
  runServerEffect(
    runArchiveNow(getRequest().headers).pipe(Effect.provide(services))
  )
)
