import type { AnyRouteMatch } from "@tanstack/react-router"
import { Effect } from "effect"

import type { Feature } from "@/server/auth/policy"

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** The feature a page in the shell belongs to; the sign-in gate asks the access policy about it. */
    feature?: Feature
  }
}

/** The feature of the deepest matched route that names one. */
export const pageFeature = (
  matches: ReadonlyArray<AnyRouteMatch>
): Effect.Effect<Feature | undefined> =>
  Effect.sync(
    () =>
      [...matches].reverse().find((match) => match.staticData.feature)
        ?.staticData.feature
  )
