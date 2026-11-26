import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { Effect, Layer } from "effect"

import { archiveDbD1 } from "@/server/archive/archive-db"
import { Auth } from "@/server/auth/auth"
import {
  disclosureBucketR2,
  disclosureWorkflowBinding,
} from "@/server/disclosures/bindings"

import { disclosureArchivePage, runDisclosuresNow } from "./disclosures.ts"

const services = Layer.mergeAll(
  Auth.layer,
  archiveDbD1,
  disclosureBucketR2,
  disclosureWorkflowBinding
)

export const disclosureArchiveFn = createServerFn({ method: "GET" }).handler(
  () =>
    runServerEffect(
      disclosureArchivePage(getRequest().headers).pipe(Effect.provide(services))
    )
)

export const runDisclosuresNowFn = createServerFn({ method: "POST" }).handler(
  () =>
    runServerEffect(
      runDisclosuresNow(getRequest().headers).pipe(Effect.provide(services))
    )
)
