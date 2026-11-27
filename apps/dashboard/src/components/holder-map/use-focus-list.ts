// The Holder map search's stocks, holders and custodians as of the map's
// day, loaded once the page opens and again for each day picked.
import { isRedirect } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { Effect, Fiber } from "effect"
import type { WibDate } from "@workspace/relay"
import { useEffect, useMemo, useState } from "react"

import { signInAgain } from "@/components/market-live/sign-in-again"
import type { FocusList } from "@/lib/holder-map-search"
import { holderMapSearchListFn } from "@/server/stocks/stocks.functions"

export type FocusListState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly list: FocusList }

const LOADING: FocusListState = { _tag: "Loading" }

// `href` is the page the visitor returns to after signing in again: a 401
// arrives as the router's redirect, and sends them there, the list still
// loading. A failed load keeps the search loading, with a warning logged;
// the page itself still shows.
// `day` is the map's as-of day, undefined for the newest. A list loaded for
// another day is never shown: the search loads until its own day's list
// arrives.
export function useFocusList(
  href: string,
  day: WibDate | undefined
): FocusListState {
  const [loaded, setLoaded] = useState<{
    readonly day: WibDate | undefined
    readonly list: FocusList
  }>()
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      Effect.tryPromise({
        try: () => holderMapSearchListFn({ data: { href, day } }),
        catch: (thrown) => thrown,
      }).pipe(
        Effect.tap((list) => Effect.sync(() => setLoaded({ day, list }))),
        Effect.catchIf(isRedirect, () => signInAgain),
        Effect.tapError((error) =>
          Effect.logWarning("Holder map search not loaded", error)
        ),
        Effect.ignore
      )
    )
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [href, day])
  return useMemo(
    () =>
      loaded === undefined || loaded.day !== day
        ? LOADING
        : { _tag: "Ready", list: loaded.list },
    [loaded, day]
  )
}
