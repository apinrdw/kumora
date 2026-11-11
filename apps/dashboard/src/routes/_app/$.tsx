import { createFileRoute } from "@tanstack/react-router"
import { Effect } from "effect"

import { unclaimedPage } from "@/lib/unclaimed-page"

export const Route = createFileRoute("/_app/$")(Effect.runSync(unclaimedPage))
