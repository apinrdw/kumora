import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { Effect, Layer } from "effect"

import { archiveDbD1 } from "@/server/archive/archive-db"
import { Auth } from "@/server/auth/auth"
import { holdingsDbD1 } from "@/server/holdings/db"
import {
  above1ParseWorkflowBinding,
  archiveBucketR2,
  archiveWorkflowBinding,
  classificationParseWorkflowBinding,
  investorTypeParseWorkflowBinding,
} from "@/server/shareholding/bindings"

import {
  parseAbove1Now,
  parseClassificationNow,
  parseInvestorTypeNow,
  runArchiveNow,
  shareholdingArchivePage,
} from "./shareholding.ts"

const services = Layer.mergeAll(
  Auth.layer,
  archiveDbD1,
  holdingsDbD1,
  archiveBucketR2,
  archiveWorkflowBinding,
  classificationParseWorkflowBinding,
  investorTypeParseWorkflowBinding,
  above1ParseWorkflowBinding
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

export const parseInvestorTypeNowFn = createServerFn({
  method: "POST",
}).handler(() =>
  runServerEffect(
    parseInvestorTypeNow(getRequest().headers).pipe(Effect.provide(services))
  )
)

export const parseAbove1NowFn = createServerFn({
  method: "POST",
}).handler(() =>
  runServerEffect(
    parseAbove1Now(getRequest().headers).pipe(Effect.provide(services))
  )
)
