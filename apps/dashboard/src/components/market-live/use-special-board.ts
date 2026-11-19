import { clientRuntime, fetchSpecialBoard } from "@workspace/client"
import type { StockCode } from "@workspace/relay"
import { Effect, Fiber } from "effect"
import { useEffect, useState } from "react"

const NONE: ReadonlySet<StockCode> = new Set()

// The Special Monitoring Board's codes, fetched once a page visit; the
// browser keeps the answer an hour. Until it comes, or when it fails, no code
// is on the board.
export function useSpecialBoard(): ReadonlySet<StockCode> {
  const [board, setBoard] = useState(NONE)
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      fetchSpecialBoard.pipe(
        Effect.flatMap(({ codes }) =>
          Effect.sync(() => setBoard(new Set(codes)))
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "The Special Monitoring Board list couldn't be read",
            cause
          )
        )
      )
    )
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  return board
}
