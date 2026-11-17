import { createFileRoute } from "@tanstack/react-router"
import { runServerEffect } from "@workspace/server"

import { logoResponse } from "@/server/logos/serve"

// A stock code's logo, for Market Bubbles' canvas (src/server/logos/serve.ts).
export const Route = createFileRoute("/logos/$code")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        runServerEffect(
          logoResponse(params.code, request.headers.get("if-none-match"))
        ),
    },
  },
})
