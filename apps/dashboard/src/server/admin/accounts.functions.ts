import { createServerFn } from "@tanstack/react-start"
import { getRequest } from "@tanstack/react-start/server"
import { runServerEffect } from "@workspace/server"
import { Effect, Schema } from "effect"

import { AccountSearch } from "@/lib/account-query"
import { Auth } from "@/server/auth/auth"

import { listAccounts } from "./accounts.ts"

export const listAccountsFn = createServerFn({ method: "GET" })
  .validator(Schema.decodeUnknownSync(AccountSearch))
  .handler(({ data }) =>
    runServerEffect(
      listAccounts(getRequest().headers, data).pipe(Effect.provide(Auth.layer))
    )
  )
