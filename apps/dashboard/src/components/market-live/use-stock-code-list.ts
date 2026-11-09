import { clientRuntime, fetchStockCodeList } from "@workspace/client"
import { wibDateAt, type ListedCode } from "@workspace/relay"
import { DateTime, Effect, Fiber, Option } from "effect"
import { useEffect, useState } from "react"

import { withRedirect } from "@/lib/redirect"

// The page's stock code list: loading, today's list, or none yet (the relay
// sends it when it starts, or the Worker couldn't answer).
export type StockCodeList =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly codes: ReadonlyArray<ListedCode> }
  | { readonly _tag: "Missing" }

const LOADING: StockCodeList = { _tag: "Loading" }
const MISSING: StockCodeList = { _tag: "Missing" }

// Today's list; a 401 sends the visitor to sign in and back.
const loadStockCodeList = (setList: (list: StockCodeList) => void) =>
  Effect.gen(function* () {
    const today = yield* wibDateAt(yield* DateTime.now)
    const codes = yield* fetchStockCodeList(today)
    setList(
      Option.match(codes, {
        onNone: () => MISSING,
        onSome: (found) => ({ _tag: "Ready", codes: found }),
      })
    )
  }).pipe(
    Effect.catchTag("SignInRequired", () =>
      Effect.sync(() => {
        const { pathname, search } = window.location
        window.location.assign(withRedirect("/sign-in", `${pathname}${search}`))
      })
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Stock code list not loaded", cause).pipe(
        Effect.andThen(Effect.sync(() => setList(MISSING)))
      )
    )
  )

// Fetched once per page visit; the browser caches it for the day.
export function useStockCodeList(): StockCodeList {
  const [list, setList] = useState<StockCodeList>(LOADING)
  useEffect(() => {
    const fiber = clientRuntime.runFork(loadStockCodeList(setList))
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  return list
}
