import { Link } from "@tanstack/react-router"
import { clientRuntime, fetchDayStrip } from "@workspace/client"
import type { RecordedDay, WibDate } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect, Fiber } from "effect"
import { useEffect, useState } from "react"

import { dayLabel, direction, pct } from "@/lib/format"
import type { MarketLiveSearch } from "@/lib/market-live-search"

import { signInAgain } from "./sign-in-again"

const NO_DAYS: ReadonlyArray<RecordedDay> = []

const TONE = {
  up: "text-up",
  down: "text-down",
  flat: "text-muted-foreground",
} as const

const ITEM =
  "flex h-10 shrink-0 flex-col justify-center rounded-md border border-border px-2.5 py-1 text-[12px] leading-4 hover:bg-muted aria-[current=page]:border-foreground aria-[current=page]:bg-muted"

// The day strip (spec apinrdw/kumora#138, "Closed market and recorded
// days"): Today · live, then each recorded day newest first with IHSG's
// change. `shown` is the URL's day; none means the live page.
export function DayStrip({ shown }: { shown: WibDate | undefined }) {
  const [days, setDays] = useState(NO_DAYS)
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      fetchDayStrip().pipe(
        Effect.flatMap((strip) => Effect.sync(() => setDays(strip))),
        Effect.catchTag("SignInRequired", () => signInAgain),
        Effect.catchCause((cause) =>
          Effect.logWarning("Day strip not loaded", cause)
        )
      )
    )
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  return (
    <nav aria-label="Trading days" className="overflow-x-auto">
      <ul className="flex gap-2">
        <li>
          <Link
            to="/market-live"
            search={(previous: MarketLiveSearch) => ({
              ...previous,
              day: undefined,
            })}
            aria-current={shown === undefined ? "page" : undefined}
            className={ITEM}
          >
            <span className="font-semibold">Today · live</span>
          </Link>
        </li>
        {days.map(({ day, ihsg }) => (
          <li key={day}>
            <Link
              to="/market-live"
              search={(previous: MarketLiveSearch) => ({ ...previous, day })}
              aria-current={shown === day ? "page" : undefined}
              className={ITEM}
            >
              <span className="font-semibold">{dayLabel(day)}</span>
              <span
                className={cn(
                  "tabular-nums",
                  ihsg === undefined
                    ? "text-muted-foreground"
                    : TONE[direction(ihsg.change)]
                )}
              >
                {ihsg === undefined ? "—" : `IHSG ${pct(ihsg.changePercent)}`}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
