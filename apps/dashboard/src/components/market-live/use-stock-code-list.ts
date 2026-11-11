import { clientRuntime, fetchStockCodeList } from "@workspace/client"
import type { ListedCode, WibDate } from "@workspace/relay"
import { Duration, Effect, Fiber, Option, Schedule } from "effect"
import { useEffect, useState } from "react"

import { signInAgain } from "./sign-in-again"

// The page's stock code list: loading (no answer yet), the day's list, or
// none (the Worker answered that it has none: the relay sends it when it
// starts).
export type StockCodeList =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly codes: ReadonlyArray<ListedCode> }
  | { readonly _tag: "Missing" }

const LOADING: StockCodeList = { _tag: "Loading" }
const MISSING: StockCodeList = { _tag: "Missing" }

// Decision: on the live day a missing list (the Worker's 404, `no-store`, so
// each ask reaches it) is asked for again every RETRY_INTERVAL, so the page
// picks the list up without a reload once the relay delivers it. A recorded
// day's list is fixed, so its 404 is final. An ask that failed, a 5xx or a
// dropped request, is asked again every RETRY_INTERVAL on either day and
// hands the page nothing, so a Worker that couldn't answer never looks like
// one that has no list (as packages/client/src/recorded-day.ts decides for
// every recorded GET).
export const RETRY_INTERVAL = Duration.seconds(15)

// `day`'s list, or none; a 401 sends the visitor to sign in and back. Fails
// as the fetch does.
const loadStockCodeList = (day: WibDate) =>
  Effect.gen(function* () {
    const codes = yield* fetchStockCodeList(day)
    return Option.match(codes, {
      onNone: () => MISSING,
      onSome: (found): StockCodeList => ({ _tag: "Ready", codes: found }),
    })
  }).pipe(
    Effect.catchTag("SignInRequired", () => Effect.as(signInAgain, MISSING))
  )

// The list of the day shown, handed to `setList` as it comes: a recorded
// day's once it is answered; the live page's, `today` on the market clock,
// again while it is missing.
export const followStockCodeList = (
  shown: WibDate | undefined,
  today: WibDate,
  setList: (list: StockCodeList) => void
) => {
  const load = loadStockCodeList(shown ?? today).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Stock code list not loaded", error)
    ),
    Effect.retry(Schedule.spaced(RETRY_INTERVAL)),
    Effect.tap((list) => Effect.sync(() => setList(list)))
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
