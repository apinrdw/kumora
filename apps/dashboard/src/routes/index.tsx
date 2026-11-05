import { createFileRoute, redirect } from "@tanstack/react-router"

/** Whale Radar is the landing page. Temporary, so `/` can serve a page again later. */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/radar", statusCode: 307 })
  },
})
