import { notFound } from "@tanstack/react-router"
import { runLoader } from "@workspace/server/loader"
import { Effect } from "effect"

/**
 * Route options for a URL no page claims yet (`/`, and the `_app` splat): the
 * gate still runs, then the shell shows not found. It shows no data, so it
 * counts as part of the account's own pages, which every verified account
 * may view. A new object per route, because the router writes the route's id
 * into its options.
 */
export const unclaimedPage = Effect.sync(
  () =>
    ({
      staticData: { feature: "account" },
      loader: () => runLoader(Effect.die(notFound())),
    }) as const
)
