import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"

import { Auth } from "@/server/auth/auth"
import { holdingsDbD1 } from "@/server/holdings/db"

import { runSectorSyncNow, sectorTable } from "./sectors.ts"

const services = Layer.mergeAll(Auth.layer, holdingsDbD1, FetchHttpClient.layer)

export const sectorTableFn = createServerFn({ method: "GET" }).handler(() =>
  runServerEffect(
    sectorTable(getRequest().headers).pipe(Effect.provide(services))
  )
)

export const runSectorSyncNowFn = createServerFn({ method: "POST" }).handler(
  () =>
    runServerEffect(
      runSectorSyncNow(getRequest().headers).pipe(Effect.provide(services))
    )
)
