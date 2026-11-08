import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { Effect } from "effect"

import { safeRedirect } from "@/lib/redirect"

import { accountPage } from "./account-page.ts"
import { Auth } from "./auth.ts"

export const accountPageFn = createServerFn({ method: "GET" })
  .validator((href: unknown) => safeRedirect(href))
  .handler(({ data }) =>
    runServerEffect(
      accountPage(getRequest().headers, data).pipe(Effect.provide(Auth.layer))
    )
  )
