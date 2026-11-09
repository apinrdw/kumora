import { clientRuntime, fetchStockCodeList } from "@workspace/client"
import type { ListedCode, WibDate } from "@workspace/relay"
import { Effect, Fiber, Option } from "effect"
import { useEffect, useState } from "react"

import { signInAgain } from "./sign-in-again"

// The page's stock code list: loading, today's list, or none yet (the relay
// sends it when it starts, or the Worker couldn't answer).
export type StockCodeList =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly codes: ReadonlyArray<ListedCode> }
  | { readonly _tag: "Missing" }

const LOADING: StockCodeList = { _tag: "Loading" }
const MISSING: StockCodeList = { _tag: "Missing" }

// `day`'s list; a 401 sends the visitor to sign in and back.
const loadStockCodeList = (
  day: WibDate,
  setList: (list: StockCodeList) => void
) =>
  Effect.gen(function* () {
    const codes = yield* fetchStockCodeList(day)
    setList(
      Option.match(codes, {
        onNone: () => MISSING,
        onSome: (found) => ({ _tag: "Ready", codes: found }),
      })
    )
  }).pipe(
    Effect.catchTag("SignInRequired", () => signInAgain),
    Effect.catchCause((cause) =>
      Effect.logWarning("Stock code list not loaded", cause).pipe(
        Effect.andThen(Effect.sync(() => setList(MISSING)))
      )
    )
  )

// Fetched once per page visit and day shown: a recorded day's, or the live
// page's, which is `today` on the market clock (the route loader's date, not
// the browser's: the Test stage shifts only the Worker's clock). The browser
// caches it for the day.
export function useStockCodeList(
  shown: WibDate | undefined,
  today: WibDate
): StockCodeList {
  const [list, setList] = useState<StockCodeList>(LOADING)
  const day = shown ?? today
  useEffect(() => {
    const fiber = clientRuntime.runFork(loadStockCodeList(day, setList))
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [day])
  return list
}
