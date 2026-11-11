import { IconX } from "@tabler/icons-react"
import type { StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { memo } from "react"

import { KIconButton } from "@/components/k/button"
import { KStatusPill } from "@/components/k/status-pill"
import { compact, direction, pct, plain, price, signed } from "@/lib/format"

import {
  useDayState,
  useDayStateFallback,
  type DayStateStore,
} from "./day-state-store"
import { useAuctionIndicative, useMergedStale } from "./market-conditions"
import { StockCodePicker } from "./stock-code-picker"
import type { StockCodeList } from "./use-stock-code-list"

const CELL = "h-7 px-1.5 whitespace-nowrap tabular-nums"

const CHANGE_TONE = {
  up: "text-up",
  down: "text-down",
  flat: "text-muted-foreground",
} as const

interface RowProps {
  readonly code: StockCode
  readonly store: DayStateStore
  readonly onSelect: (code: StockCode) => void
  readonly onRemove: (code: StockCode) => void
}

// One code's row; it re-renders only when its own Day state changes.
const WatchlistRow = memo(function WatchlistRow({
  code,
  store,
  onSelect,
  onRemove,
}: RowProps) {
  const state = useDayState(store, code)
  // During an auction the row shows where the code would match. Before the
  // day's first PRICE or liveprice frame it may be all the code has: it shows
  // alone, the figures' cells saying nothing traded yet.
  const indicative = useAuctionIndicative(code)
  const change = state?.change
  const tone =
    change === undefined
      ? ""
      : CHANGE_TONE[Effect.runSync(direction(change.amount))]
  return (
    <tr data-code={code} className="border-b border-border/60">
      <td className={cn(CELL, "pl-2 font-semibold")}>
        <button
          type="button"
          className="hover:underline"
          onClick={() => onSelect(code)}
        >
          {code}
        </button>
      </td>
      {indicative !== undefined ? (
        <td className={cn(CELL, "text-right")}>
          <span className="mr-1 text-[10px] text-muted-foreground">
            Indicative
          </span>
          {Effect.runSync(price(indicative.price))}
        </td>
      ) : state !== undefined ? (
        <td className={cn(CELL, "text-right", tone)}>
          {Effect.runSync(price(state.last))}
        </td>
      ) : (
        <td colSpan={5} className={cn(CELL, "text-muted-foreground")}>
          no data yet
        </td>
      )}
      {state !== undefined ? (
        <>
          <td className={cn(CELL, "text-right", tone)}>
            {change === undefined ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              <>
                {Effect.runSync(
                  signed(change.amount, Number.isInteger(change.amount) ? 0 : 2)
                )}{" "}
                <span className="text-[11px]">
                  {Effect.runSync(pct(change.percent))}
                </span>
              </>
            )}
          </td>
          <td className={cn(CELL, "text-right")}>
            {Effect.runSync(compact(state.value))}
          </td>
          <td className={cn(CELL, "text-right")}>
            {Effect.runSync(compact(state.volume))}
          </td>
          <td className={cn(CELL, "text-right")}>
            {Effect.runSync(plain(state.frequency))}
          </td>
        </>
      ) : (
        indicative !== undefined && (
          <td colSpan={4} className={cn(CELL, "text-muted-foreground")}>
            no trades yet
          </td>
        )
      )}
      <td className={cn(CELL, "w-7 px-0")}>
        <KIconButton
          icon={IconX}
          label={`Remove ${code}`}
          size="sm"
          tooltip={false}
          onClick={() => onRemove(code)}
        />
      </td>
    </tr>
  )
})

// The viewer's watchlist (spec apinrdw/kumora#138, "Watchlist"): each code's
// Day state, live from the viewer socket through `store`. Clicking a code
// selects it. The header names Ajaib when the figures are its fallback.
export function Watchlist({
  codes,
  list,
  store,
  onAdd,
  onRemove,
  onSelect,
}: {
  codes: ReadonlyArray<StockCode>
  list: StockCodeList
  store: DayStateStore
  onAdd: (code: StockCode) => void
  onRemove: (code: StockCode) => void
  onSelect: (code: StockCode) => void
}) {
  const fallback = useDayStateFallback(store)
  // Both feeds down: the last figures stay, dimmed.
  const stale = useMergedStale()
  return (
    <section
      aria-label="Watchlist"
      data-stale={stale || undefined}
      className="flex flex-col gap-2"
    >
      <header className="flex items-center gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Watchlist
          {stale && <KStatusPill status="stale" />}
        </h2>
        {fallback && (
          <span
            className="text-warning ring-warning/40 rounded-xs px-1 text-[11px] ring-1"
            title="Stockbit's live prices are lost: figures from Ajaib and the merged tape."
          >
            Ajaib
          </span>
        )}
        <StockCodePicker
          list={list}
          label="Add code…"
          placeholder="Add code…"
          onPick={onAdd}
          className="ml-auto w-full max-w-[180px]"
        />
      </header>
      {codes.length === 0 ? (
        <p className="py-4 text-center text-[13px] text-muted-foreground">
          No codes yet. Add one above.
        </p>
      ) : (
        <table className={cn("w-full text-[12px]", stale && "opacity-50")}>
          <thead className="text-[11px] text-muted-foreground">
            <tr className="border-b border-border">
              <th className={cn(CELL, "pl-2 text-left font-medium")}>Code</th>
              <th className={cn(CELL, "text-right font-medium")}>Last</th>
              <th className={cn(CELL, "text-right font-medium")}>Change</th>
              <th className={cn(CELL, "text-right font-medium")}>Value</th>
              <th className={cn(CELL, "text-right font-medium")}>Lot</th>
              <th className={cn(CELL, "text-right font-medium")}>Freq</th>
              <th className={CELL}>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {codes.map((code) => (
              <WatchlistRow
                key={code}
                code={code}
                store={store}
                onSelect={onSelect}
                onRemove={onRemove}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
