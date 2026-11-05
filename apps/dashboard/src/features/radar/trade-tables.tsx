// The live page's trade rows: the session's off-board trades, and the raw tape of every board.
import { cn } from "@workspace/ui/lib/utils"

import type { Trade, TradeSide } from "@/domain/trade"
import { plain } from "@/lib/format"
import { SHARES_PER_LOT } from "@/relay/exchange"
import { TAPE_KEEP } from "@/relay/routes"

import { lots, money, wib } from "./whale-format"

const SIDE_COPY: Record<TradeSide, string> = {
  buy: "Buy",
  sell: "Sell",
  unspecified: "—",
}

const LAYOUTS = {
  offBoard: {
    grid: "grid-cols-[64px_40px_minmax(0,1fr)_88px_64px]",
    side: false,
  },
  raw: {
    grid: "grid-cols-[64px_40px_40px_minmax(0,1fr)_88px_64px]",
    side: true,
  },
} as const

type Layout = (typeof LAYOUTS)[keyof typeof LAYOUTS]

/** A row's React key. The list holds one trading day, so the trade number is enough. */
const rowKey = (t: Trade) => t.tradeNumber

function Cells({ trade, side }: { trade: Trade; side: boolean }) {
  return (
    <>
      <time className="text-muted-foreground">{wib(trade.tradedAt)}</time>
      <span>{trade.board}</span>
      {side && <span>{SIDE_COPY[trade.side]}</span>}
      <span className="text-right">{plain(trade.price)}</span>
      <span className="text-right font-[650]">
        {lots(trade.volume / SHARES_PER_LOT)}
      </span>
      <span className="text-right">{money(trade.value)}</span>
    </>
  )
}

function Header({ layout: { grid, side } }: { layout: Layout }) {
  return (
    <div className={cn("grid gap-x-2 text-[11px] text-muted-foreground", grid)}>
      <span>Time</span>
      <span>Board</span>
      {side && <span>Side</span>}
      <span className="text-right">Price</span>
      <span className="text-right">Lots</span>
      <span className="text-right">Value</span>
    </div>
  )
}

function Rows({
  trades,
  layout: { grid, side },
}: {
  trades: ReadonlyArray<Trade>
  layout: Layout
}) {
  return (
    <ol className="max-h-[320px] overflow-y-auto">
      {trades.map((trade) => (
        <li
          key={rowKey(trade)}
          className={cn(
            "num grid gap-x-2 border-t border-border py-1.5 text-xs",
            grid
          )}
        >
          <Cells trade={trade} side={side} />
        </li>
      ))}
    </ol>
  )
}

/** The session's off-board trades, newest first. None of them moves a candle, the profile, a sweep, a wall or the last price. */
export function OffBoardList({ trades }: { trades: ReadonlyArray<Trade> }) {
  return (
    <section aria-label="Off-board trades" className="flex flex-col gap-2">
      <h2 className="text-sm font-[650]">{`Off-board · ${plain(trades.length)}`}</h2>
      {trades.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No off-board trades this session.
        </p>
      ) : (
        <div>
          <Header layout={LAYOUTS.offBoard} />
          <Rows trades={trades} layout={LAYOUTS.offBoard} />
        </div>
      )}
    </section>
  )
}

/** The newest trades from every board, collapsed until asked for. An off-board row differs only in its board. */
export function RawTape({ trades }: { trades: ReadonlyArray<Trade> }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-[11px] text-muted-foreground">
        {`Raw tape · newest ${TAPE_KEEP} trades`}
      </summary>
      <div className="mt-2">
        <Header layout={LAYOUTS.raw} />
        <Rows trades={trades} layout={LAYOUTS.raw} />
      </div>
    </details>
  )
}
