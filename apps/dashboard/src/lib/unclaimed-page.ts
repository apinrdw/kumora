import { notFound } from "@tanstack/react-router"

/**
 * Route options for a URL no page claims yet (`/`, and the `_app` splat): the
 * gate still runs, then the shell shows not found. It shows no data, so it
 * counts as part of the account's own pages, which every verified account
 * may view. A new object per route, because the router writes the route's id
 * into its options.
 */
export const unclaimedPage = () =>
  ({
    staticData: { feature: "account" },
    loader: () => {
      throw notFound()
    },
  }) as const
