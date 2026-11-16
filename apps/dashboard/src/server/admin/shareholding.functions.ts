import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { Effect, Layer } from "effect"

import { Auth } from "@/server/auth/auth"
import {
  archiveBucketR2,
  archiveWorkflowBinding,
  classificationParseWorkflowBinding,
} from "@/server/shareholding/bindings"

import {
  parseClassificationNow,
  runArchiveNow,
  shareholdingArchivePage,
} from "./shareholding.ts"

const services = Layer.mergeAll(
  Auth.layer,
  archiveBucketR2,
  archiveWorkflowBinding,
  classificationParseWorkflowBinding
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

export const parseClassificationNowFn = createServerFn({
  method: "POST",
}).handler(() =>
  runServerEffect(
    parseClassificationNow(getRequest().headers).pipe(Effect.provide(services))
  )
)
