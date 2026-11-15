import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { Effect, Layer, Schema } from "effect"

import { safeRedirect } from "@/lib/redirect"
import { Auth } from "@/server/auth/auth"
import { holdingsDbD1 } from "@/server/holdings/db"

import { stockListView, stockPageView } from "./stocks.ts"

const services = Layer.mergeAll(Auth.layer, holdingsDbD1)

const decodeStockPage = Schema.decodeUnknownSync(
  Schema.Struct({
    code: Schema.String,
    month: Schema.optional(Schema.String),
  })
)

// /stocks/$CODE's loader.
export const stockPageFn = createServerFn({ method: "GET" })
  .validator(decodeStockPage)
  .handler(({ data }) =>
    runServerEffect(
      stockPageView(getRequest().headers, data.code, data.month).pipe(
        Effect.provide(services)
      )
    )
  )

// The stock picker's list; `data` is the page the visitor returns to after
// signing in again.
export const stockListFn = createServerFn({ method: "GET" })
  .validator((href: unknown) => Effect.runSync(safeRedirect(href)))
  .handler(({ data }) =>
    runServerEffect(
      stockListView(getRequest().headers, data).pipe(Effect.provide(services))
    )
  )
