import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { Effect, Layer } from "effect"

import { Auth } from "@/server/auth/auth"
import {
  kseiBucketR2,
  kseiParseWorkflowBinding,
  kseiWorkflowBinding,
} from "@/server/ksei/bindings"

import {
  deepBackfillKsei,
  kseiArchivePage,
  parseKseiNow,
  runKseiNow,
} from "./ksei.ts"

const services = Layer.mergeAll(
  Auth.layer,
  kseiBucketR2,
  kseiWorkflowBinding,
  kseiParseWorkflowBinding
)

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

export const deepBackfillKseiFn = createServerFn({ method: "POST" }).handler(
  () =>
    runServerEffect(
      deepBackfillKsei(getRequest().headers).pipe(Effect.provide(services))
    )
)

export const parseKseiNowFn = createServerFn({ method: "POST" }).handler(() =>
  runServerEffect(
    parseKseiNow(getRequest().headers).pipe(Effect.provide(services))
  )
)
