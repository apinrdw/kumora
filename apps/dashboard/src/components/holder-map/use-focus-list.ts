// The Holder map search's stocks, holders and custodians as of the map's
// day, loaded once the page opens and again for each day picked.
import { isRedirect } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { Effect, Fiber } from "effect"
import type { WibDate } from "@workspace/relay"
import { useEffect, useState } from "react"

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
// `day` is the map's as-of day, undefined for the newest.
export function useFocusList(
  href: string,
  day: WibDate | undefined
): FocusListState {
  const [state, setState] = useState<FocusListState>(LOADING)
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      Effect.tryPromise({
        try: () => holderMapSearchListFn({ data: { href, day } }),
        catch: (thrown) => thrown,
      }).pipe(
        Effect.map((list): FocusListState => ({ _tag: "Ready", list })),
        Effect.catchIf(isRedirect, () => Effect.as(signInAgain, LOADING)),
        Effect.tapError((error) =>
          Effect.logWarning("Holder map search not loaded", error)
        ),
        Effect.tap((loaded) => Effect.sync(() => setState(loaded))),
        Effect.ignore
      )
    )
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [href, day])
  return state
}
