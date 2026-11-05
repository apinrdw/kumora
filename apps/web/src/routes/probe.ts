import { createFileRoute } from "@tanstack/react-router"
import { runServerEffect } from "@workspace/server"

import { probe } from "@/server/probe"

export const Route = createFileRoute("/probe")({
  server: {
    handlers: {
      GET: ({ request }) => runServerEffect(probe(request)),
    },
  },
})
