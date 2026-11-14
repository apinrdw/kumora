import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { Effect, Layer } from "effect"

import { Auth } from "@/server/auth/auth"
import { kseiBucketR2, kseiWorkflowBinding } from "@/server/ksei/bindings"

import { kseiArchivePage, runKseiNow } from "./ksei.ts"

const services = Layer.mergeAll(Auth.layer, kseiBucketR2, kseiWorkflowBinding)

export const kseiArchiveFn = createServerFn({ method: "GET" }).handler(() =>
  runServerEffect(
    kseiArchivePage(getRequest().headers).pipe(Effect.provide(services))
  )
)

export const runKseiNowFn = createServerFn({ method: "POST" }).handler(() =>
  runServerEffect(
    runKseiNow(getRequest().headers).pipe(Effect.provide(services))
  )
)
