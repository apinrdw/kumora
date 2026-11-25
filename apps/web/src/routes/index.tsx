import { createFileRoute } from "@tanstack/react-router"

import { Landing } from "@/components/passbook/landing"
import { landingHead } from "@/lib/landing-head"

export const Route = createFileRoute("/")({
  head: () => landingHead("en"),
  component: () => <Landing lang="en" />,
})
