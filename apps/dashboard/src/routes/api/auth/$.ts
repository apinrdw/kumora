import { createFileRoute } from "@tanstack/react-router"
import { runServerEffect } from "@workspace/server"
import { Effect } from "effect"

import { Auth } from "@/server/auth/auth"

const handle = ({ request }: { readonly request: Request }) =>
  runServerEffect(
    Effect.gen(function* () {
      const auth = yield* Auth
      return yield* auth.handler(request)
    }).pipe(Effect.provide(Auth.layer))
  )

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handle, POST: handle } },
})
