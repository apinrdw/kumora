// The gate's server functions, called from route `beforeLoad`s. An
// Unauthorized failure reaches the router as a redirect.
import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { Effect, Schema } from "effect"

import { safeRedirect } from "@/lib/redirect"

import { Auth } from "./auth.ts"
import { gatePage, verifyScreen } from "./gate.ts"
import { FEATURES } from "./policy.ts"

const decodePage = Schema.decodeUnknownSync(
  Schema.Struct({ href: Schema.String, feature: Schema.Literals(FEATURES) })
)

export const gatePageFn = createServerFn({ method: "GET" })
  .validator((input: unknown) => {
    const page = decodePage(input)
    return { ...page, href: safeRedirect(page.href) }
  })
  .handler(({ data }) =>
    runServerEffect(
      gatePage(getRequest().headers, data).pipe(Effect.provide(Auth.layer))
    )
  )

export const verifyScreenFn = createServerFn({ method: "GET" })
  .validator((href: unknown) => safeRedirect(href))
  .handler(({ data }) =>
    runServerEffect(
      verifyScreen(getRequest().headers, data).pipe(Effect.provide(Auth.layer))
    )
  )
