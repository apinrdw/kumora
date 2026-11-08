import { createFileRoute } from "@tanstack/react-router"

import { unclaimedPage } from "@/lib/unclaimed-page"

export const Route = createFileRoute("/_app/$")(unclaimedPage())
