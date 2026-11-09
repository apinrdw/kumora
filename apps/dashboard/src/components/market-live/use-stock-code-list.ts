import { clientRuntime, fetchStockCodeList } from "@workspace/client"
import type { ListedCode, WibDate } from "@workspace/relay"
import { Duration, Effect, Fiber, Option, Schedule } from "effect"
import { useEffect, useState } from "react"

import { signInAgain } from "./sign-in-again"

// The page's stock code list: loading, the day's list, or none yet (the
// relay sends it when it starts, or the Worker couldn't answer).
export type StockCodeList =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly codes: ReadonlyArray<ListedCode> }
  | { readonly _tag: "Missing" }

const LOADING: StockCodeList = { _tag: "Loading" }
const MISSING: StockCodeList = { _tag: "Missing" }

// Decision: on the live day a missing list is asked for again every
// RETRY_INTERVAL, so the page picks the list up without a reload once the
// relay delivers it; the Worker's 404 is `no-store`, so each ask reaches
// it. A recorded day's list is fixed, so a missing one stays missing.
export const RETRY_INTERVAL = Duration.seconds(15)

// `day`'s list; a 401 sends the visitor to sign in and back.
const loadStockCodeList = (day: WibDate) =>
  Effect.gen(function* () {
    const codes = yield* fetchStockCodeList(day)
    return Option.match(codes, {
      onNone: () => MISSING,
      onSome: (found): StockCodeList => ({ _tag: "Ready", codes: found }),
    })
  }).pipe(
    Effect.catchTag("SignInRequired", () => Effect.as(signInAgain, MISSING)),
    Effect.catchCause((cause) =>
      Effect.as(Effect.logWarning("Stock code list not loaded", cause), MISSING)
    )
  )

// The list of the day shown, handed to `setList` as it comes: a recorded
// day's once; the live page's, `today` on the market clock, again while it
// is missing.
export const followStockCodeList = (
  shown: WibDate | undefined,
  today: WibDate,
  setList: (list: StockCodeList) => void
) => {
  const load = Effect.tap(loadStockCodeList(shown ?? today), (list) =>
    Effect.sync(() => setList(list))
  )
  return shown === undefined
    ? Effect.repeat(load, {
        schedule: Schedule.spaced(RETRY_INTERVAL),
        while: (list) => list._tag === "Missing",
      })
    : load
}

// Fetched per page visit and day shown: a recorded day's, or the live
// page's, which is `today` on the market clock (the route loader's date, not
// the browser's: the Test stage shifts only the Worker's clock). The browser
// caches it for the day.
export function useStockCodeList(
  shown: WibDate | undefined,
  today: WibDate
): StockCodeList {
  const [list, setList] = useState<StockCodeList>(LOADING)
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      followStockCodeList(shown, today, setList)
    )
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [shown, today])
  return list
}
