import { Link } from "@tanstack/react-router"
import { clientRuntime, fetchDayStrip } from "@workspace/client"
import type { RecordedDay, WibDate } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"

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

// Decision: the strip is loaded on mount, and again, past the copy the
// browser keeps until 17:01 WIB (day-index.ts), a minute after the loader
// first says the market shut on a day: that is the 17:00 seal, which writes
// the day's row; the seal's flush and index row take seconds, and a row its
// retry lands later shows on the next load, as day-index.ts decides. The
// loader's day at mount, a weekend's or an evening's, is in the copy already.
// Midnight and 08:40 change the loader's answer, not the days recorded.
const SEAL_SETTLED = "1 minute"

const stripLoad = (
  fresh: boolean,
  setDays: (days: ReadonlyArray<RecordedDay>) => void
) =>
  fetchDayStrip(fresh).pipe(
    Effect.flatMap((strip) => Effect.sync(() => setDays(strip))),
    Effect.catchTag("SignInRequired", () => signInAgain),
    Effect.catchCause((cause) =>
      Effect.logWarning("Day strip not loaded", cause)
    )
  )

// Runs `effect` until the effect hook's cleanup.
const fork = (effect: Effect.Effect<void>) => {
  const fiber = clientRuntime.runFork(effect)
  return () => {
    clientRuntime.runFork(Fiber.interrupt(fiber))
  }
}

// The day strip (spec apinrdw/kumora#138, "Closed market and recorded
// days"): Today · live, then each recorded day newest first with IHSG's
// change. `shown` is the URL's day; none means the live page. `closedDay` is
// the day the loader says the market shut on; none while it's open.
export function DayStrip({
  shown,
  closedDay,
}: {
  shown: WibDate | undefined
  closedDay: WibDate | undefined
}) {
  const [days, setDays] = useState(NO_DAYS)
  useEffect(() => fork(stripLoad(false, setDays)), [])
  const shutOn = useRef(closedDay)
  useEffect(() => {
    const sealed = closedDay !== undefined && closedDay !== shutOn.current
    shutOn.current = closedDay
    if (!sealed) return
    return fork(Effect.delay(stripLoad(true, setDays), SEAL_SETTLED))
  }, [closedDay])
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
