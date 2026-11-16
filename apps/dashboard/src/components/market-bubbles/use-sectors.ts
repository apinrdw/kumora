import { clientRuntime, fetchSectors } from "@workspace/client"
import { Effect, Fiber } from "effect"
import { useEffect, useState } from "react"

import { sectorLookup, type SectorLookup } from "@/lib/bubble-sectors"

const NONE: SectorLookup = new Map()

// Every classified code's sector, fetched once a page visit; the browser
// keeps the answer an hour. Until it comes, or when it fails, every code is
// Unclassified.
export function useSectors(): SectorLookup {
  const [lookup, setLookup] = useState(NONE)
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      fetchSectors.pipe(
        Effect.flatMap(sectorLookup),
        Effect.flatMap((found) => Effect.sync(() => setLookup(found))),
        Effect.catchCause((cause) =>
          Effect.logWarning("Sectors couldn't be read", cause)
        )
      )
    )
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  return lookup
}
