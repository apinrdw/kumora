import { Link } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode, UIEvent } from "react"

import { KEmptyState, KStatusPill } from "@/components/k"
import type { Symbol } from "@/domain/symbol"
import type { Sweep, Wall, WhalesToday } from "@/domain/trade"
import {
  lots,
  money,
  sweepLine,
  wallSide,
  wallState,
  wib,
} from "./whale-format"
import { plain } from "@/lib/format"
import { LIVE_PAGE_PATH, LIVE_PAGE_SEARCH } from "@/relay/routes"

import { mostSwept, useWhales } from "./whales"
import type { WhalesState } from "./whales"

/** How near the end of the feed the next page starts loading, in pixels. */
const LOAD_WITHIN_PX = 200

/** Every symbol opens on Whale Radar Live. */
function LiveLink({
  symbol,
  className,
  children,
}: {
  symbol: Symbol
  className?: string
  children: ReactNode
}) {
  return (
    <Link
      to={LIVE_PAGE_PATH}
      search={{ [LIVE_PAGE_SEARCH.symbol]: symbol }}
      className={cn("underline-offset-2 hover:underline", className)}
    >
      {children}
    </Link>
  )
}

function Header({ state }: { state: WhalesState }) {
  const { provenance, liveprice, sweepsTotal, walls, thresholds } = state
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="text-base leading-6 font-[650]">Sweep feed</h2>
      <span className="num text-xs text-muted-foreground">
        {plain(sweepsTotal)} sweeps · {plain(walls.length)} walls
      </span>
      <span className="ml-auto flex items-center gap-2">
        <KStatusPill
          status={provenance.freshness}
          {...(provenance.asOf ? { asOf: provenance.asOf } : {})}
        />
        <span className="text-[11px] text-muted-foreground">trades</span>
        <KStatusPill
          status={liveprice.freshness}
          {...(liveprice.asOf ? { asOf: liveprice.asOf } : {})}
        />
        <span className="text-[11px] text-muted-foreground">liveprice</span>
      </span>
      <span className="num w-full text-[11px] text-muted-foreground">
        Thresholds on {plain(thresholds.symbols)} symbols,{" "}
        {plain(thresholds.warmingUp)} still warming up
      </span>
    </header>
  )
}

function SweepRow({ sweep }: { sweep: Sweep }) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 whitespace-pre",
        sweep.side === "buy" ? "text-up" : "text-down"
      )}
    >
      <span className="text-warning w-3">{sweep.open ? "▶" : " "}</span>
      <LiveLink symbol={sweep.symbol}>{sweepLine(sweep)}</LiveLink>
      {sweep.warmingUp && (
        <span className="text-[10px] text-muted-foreground">warming</span>
      )}
    </li>
  )
}

function MostSwept({ state }: { state: WhalesState }) {
  const board = mostSwept(state).map((e) => ({
    ...e,
    total: e.buyValue + e.sellValue,
  }))
  const scale = board[0]?.total || 1
  return (
    <div className="flex flex-col gap-2 text-xs">
      <span className="block text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
        Most swept today, by value
      </span>
      <ol className="flex flex-col gap-1.5">
        {board.map((e) => (
          <li key={e.symbol} className="num">
            <span className="flex justify-between">
              <LiveLink
                symbol={e.symbol}
                className="font-[650] text-foreground"
              >
                {e.symbol}
              </LiveLink>
              <span>{money(e.total)}</span>
            </span>
            <span className="flex h-1.5 overflow-hidden rounded-full bg-border">
              <i
                className="bg-up"
                style={{ width: `${(e.buyValue / scale) * 100}%` }}
              />
              <i
                className="bg-down"
                style={{ width: `${(e.sellValue / scale) * 100}%` }}
              />
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function WallRow({ wall }: { wall: Wall }) {
  const gone = wall.closedAt !== null
  return (
    <li
      className={cn(
        "num flex flex-wrap items-center gap-x-3 py-1.5",
        gone && "text-muted-foreground"
      )}
    >
      <time className="w-16 text-muted-foreground">{wib(wall.firstSeen)}</time>
      <LiveLink symbol={wall.symbol} className="font-[650] text-foreground">
        {wall.symbol}
      </LiveLink>
      <b className={gone ? "" : wall.side === "bid" ? "text-up" : "text-down"}>
        {wallSide(wall)} {plain(wall.price)}
      </b>
      <span>≥{plain(wall.hitsSeen)} hits</span>
      <span>≥{lots(wall.lotsMatched)} lots</span>
      <span className="text-muted-foreground">{wallState(wall)}</span>
    </li>
  )
}

function WallsPanel({ state }: { state: WhalesState }) {
  const { walls, wallCoverage } = state
  const covered = wallCoverage.length
  return (
    <div className="flex flex-col gap-2 text-xs">
      <span className="block text-[10px] tracking-[0.1em] text-muted-foreground uppercase">
        Walls · {plain(covered)} {covered === 1 ? "symbol" : "symbols"} watched
      </span>
      {walls.length > 0 ? (
        <ul className="max-h-[240px] divide-y divide-border overflow-y-auto">
          {walls.map((wall) => (
            <WallRow
              key={`${wall.symbol}${wall.firstOrderNumber}`}
              wall={wall}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">
          {covered === 0
            ? "Walls not watched"
            : "None has reached a threshold."}
        </p>
      )}
    </div>
  )
}

/** Today's sweeps across the market, above the candidate list, which stays on demo data. */
export function SweepFeed({ today }: { today: WhalesToday }) {
  const { state, loadEarlier } = useWhales(today)
  const onScroll = ({ currentTarget: list }: UIEvent<HTMLOListElement>) => {
    if (list.scrollHeight - list.scrollTop - list.clientHeight < LOAD_WITHIN_PX)
      void loadEarlier()
  }
  return (
    <section
      aria-label="Sweep feed"
      className="bg-surface flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <Header state={state} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {state.sweeps.length === 0 ? (
          <KEmptyState
            kind="no-data"
            title="Belum ada sweep hari ini"
            description="Order pertama yang mencapai whale threshold muncul di sini."
            className="max-w-none"
          />
        ) : (
          <ol
            onScroll={onScroll}
            className="num bg-canvas max-h-[420px] overflow-y-auto rounded-md border border-border p-2 text-xs leading-5"
          >
            {state.sweeps.map((sweep) => (
              <SweepRow
                key={`${sweep.symbol}${sweep.firstNumber}`}
                sweep={sweep}
              />
            ))}
          </ol>
        )}
        <div className="flex flex-col gap-4">
          {state.sweeps.length > 0 && <MostSwept state={state} />}
          <WallsPanel state={state} />
        </div>
      </div>
    </section>
  )
}
