import type { StockCode } from "@workspace/relay"
import { Effect } from "effect"
import { useEffect, useMemo, useRef, useState, type RefObject } from "react"

import type { BookReadingsStore } from "@/components/market-live/book-readings-store"
import { scan, type RadarSettings, type Scan } from "@/lib/order-book-radar"

import type { FiguresStore } from "./figures-store"

// Decision: the order re-sorts every 5 s and holds while the pointer is over
// the halves, so a click lands on the code aimed at; readings show live in
// between. A change of the settings or watchlist, the user's own, re-sorts
// at once, and so does each second while no code is ranked yet; the board
// list landing waits for the next re-sort. See spec
// apinrdw/kumora#517, "The scanner".
const RESORT_MS = 5_000

interface Inputs {
  readonly readings: BookReadingsStore
  readonly figures: FiguresStore
  readonly settings: RadarSettings
  readonly board: ReadonlySet<StockCode>
  readonly watchlist: ReadonlySet<StockCode>
  readonly clockOffset: RefObject<number>
}

interface Ranking {
  readonly scan: Scan
  // On the browser's clock.
  readonly at: number
  // The settings and watchlist it ranked with.
  readonly basis: object
}

const rank = (inputs: Inputs, basis: object, at: number): Ranking => ({
  scan: Effect.runSync(
    scan(
      {
        readings: inputs.readings.all(),
        figures: inputs.figures.all(),
        board: inputs.board,
        watchlist: inputs.watchlist,
        now: at + inputs.clockOffset.current,
      },
      inputs.settings
    )
  ),
  at,
  basis,
})

const isEmpty = ({ scan: { bid, offer, limits } }: Ranking) =>
  bid.length + offer.length + limits.length === 0

// The halves' order, held between re-sorts, and the second's clock on the
// market's.
export function useRanking(inputs: Inputs & { readonly hovering: boolean }) {
  const { settings, watchlist, hovering } = inputs
  const basis = useMemo(() => ({ settings, watchlist }), [settings, watchlist])
  const latest = useRef({ inputs, basis, hovering })
  useEffect(() => {
    latest.current = { inputs, basis, hovering }
  })
  const [tick, setTick] = useState<{
    readonly now: number
    readonly ranking: Ranking | undefined
  }>(() => ({ now: Date.now(), ranking: undefined }))
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      const held = latest.current
      setTick(({ ranking }) => ({
        now,
        ranking:
          ranking === undefined ||
          ranking.basis !== held.basis ||
          isEmpty(ranking) ||
          (!held.hovering && now - ranking.at >= RESORT_MS)
            ? rank(held.inputs, held.basis, now)
            : ranking,
      }))
    }, 1000)
    return () => clearInterval(timer)
  }, [])
  // Ranked at once with new settings, until the next second keeps it.
  const { now } = tick
  const held = tick.ranking?.basis === basis ? tick.ranking : undefined
  const fresh = useMemo(
    () => (held === undefined ? rank(inputs, basis, now) : undefined),
    [held, inputs, basis, now]
  )
  const ranking = held ?? fresh!
  return {
    scan: ranking.scan,
    marketNow: now + inputs.clockOffset.current,
    resortsIn: Math.max(0, Math.ceil((RESORT_MS - (now - ranking.at)) / 1000)),
  }
}
