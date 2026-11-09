import { clientRuntime, fetchStockCodeList } from "@workspace/client"
import { wibDateAt, type ListedCode, type WibDate } from "@workspace/relay"
import { DateTime, Effect, Fiber, Option } from "effect"
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

// `day`'s list, or today's; a 401 sends the visitor to sign in and back.
const loadStockCodeList = (
  day: WibDate | undefined,
  setList: (list: StockCodeList) => void
) =>
  Effect.gen(function* () {
    const codes = yield* fetchStockCodeList(
      day ?? (yield* wibDateAt(yield* DateTime.now))
    )
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

// Fetched once per page visit and day shown (a recorded day's, or today's);
// the browser caches it for the day.
export function useStockCodeList(day?: WibDate): StockCodeList {
  const [list, setList] = useState<StockCodeList>(LOADING)
  useEffect(() => {
    const fiber = clientRuntime.runFork(loadStockCodeList(day, setList))
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [day])
  return list
}
