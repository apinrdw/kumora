import type { MarketPhase, RecordedDay, WibDate } from "@workspace/relay"
import { clientRuntime } from "@workspace/client"
import { cn } from "@workspace/ui/lib/utils"
import { Effect, Fiber } from "effect"
import { useEffect, useState } from "react"

import { PhaseLabel } from "@/components/market-live/market-conditions"
import { stripLoad } from "@/components/market-live/day-strip"
import { sizeFigure, type MarketFlow } from "@/lib/bubbles"
import { compact, pct, price, tapeTime, toneClass } from "@/lib/format"
import { ihsgChange, marketStrip, type MarketStrip } from "@/lib/market-strip"

// The strip's figures refresh as often as the map's.
const REFRESH_MS = 1000

const NO_DAYS: ReadonlyArray<RecordedDay> = []

// The sealed days, for IHSG's last close; none while they don't load. A
// page open overnight loads them again when the live date turns over, for
// the day that sealed since.
function useSealedDays(today: WibDate) {
  const [held, setHeld] = useState({ today, days: NO_DAYS })
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      stripLoad(false, (days) => setHeld({ today, days }))
    )
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [today])
  return held.days
}

// The market's figures each second, and the market's clock: `clockOffset`
// ms ahead of the browser's.
function useStripNow(flow: MarketFlow, clockOffset: number) {
  const [held, setHeld] = useState<{ figures: MarketStrip; now: number }>()
  useEffect(() => {
    const read = () =>
      setHeld({
        figures: Effect.runSync(marketStrip(flow)),
        now: Date.now() + clockOffset,
      })
    read()
    const timer = setInterval(read, REFRESH_MS)
    return () => clearInterval(timer)
  }, [flow, clockOffset])
  return held
}

function Figure({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <span aria-label={label} className="whitespace-nowrap">
      <span className="text-muted-foreground">{label} </span>
      {children}
    </span>
  )
}

// The header strip (spec apinrdw/kumora#427, "The header strip"): IHSG and
// its change against the last sealed day's close, the day's value and
// frequency, the up / down / unchanged counts, then the Market phase and the
// clock.
export function MarketStripBar({
  flow,
  ihsg,
  today,
  phase,
  clockOffset,
}: {
  flow: MarketFlow
  ihsg: number | undefined
  today: WibDate
  phase: MarketPhase | undefined
  clockOffset: number
}) {
  const days = useSealedDays(today)
  const held = useStripNow(flow, clockOffset)
  if (held === undefined) return null
  const { figures, now } = held
  const change =
    ihsg === undefined
      ? undefined
      : Effect.runSync(ihsgChange(ihsg, days, today))
  return (
    <div
      role="group"
      aria-label="Market figures"
      className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs"
    >
      <Figure label="IHSG">
        <b className="num">
          {ihsg === undefined ? "—" : Effect.runSync(price(ihsg))}
        </b>{" "}
        <span className={cn("num", Effect.runSync(toneClass(change)))}>
          {change === undefined ? "" : Effect.runSync(pct(change))}
        </span>
      </Figure>
      <Figure label="Value">
        <b className="num">
          {Effect.runSync(sizeFigure("value", figures.value))}
        </b>
      </Figure>
      <Figure label="Freq">
        <b className="num">{Effect.runSync(compact(figures.frequency))}</b>
      </Figure>
      <Figure label="Up">
        <b className="num text-up">{figures.up}</b>
      </Figure>
      <Figure label="Down">
        <b className="num text-down">{figures.down}</b>
      </Figure>
      <Figure label="Unchanged">
        <b className="num">{figures.unchanged}</b>
      </Figure>
      <span className="ml-auto flex gap-2 whitespace-nowrap">
        {phase !== undefined && <PhaseLabel phase={phase} />}
        <time aria-label="Market clock" className="num">
          {Effect.runSync(tapeTime(now))} WIB
        </time>
      </span>
    </div>
  )
}
