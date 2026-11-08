import { createFileRoute } from "@tanstack/react-router"

import { unclaimedPage } from "@/lib/unclaimed-page"

// The splat beside this doesn't match `/`. Market Live will claim it.
export const Route = createFileRoute("/_app/")(unclaimedPage())
