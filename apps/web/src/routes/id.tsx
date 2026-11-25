import { createFileRoute } from "@tanstack/react-router"

import { Landing } from "@/components/passbook/landing"
import { landingHead } from "@/lib/landing-head"

export const Route = createFileRoute("/id")({
  head: () => landingHead("id"),
  component: () => <Landing lang="id" />,
})
