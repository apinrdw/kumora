import { IconX } from "@tabler/icons-react"
import type { StockCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { memo } from "react"

import { KIconButton } from "@/components/k/button"
import { compact, direction, pct, plain, signed } from "@/lib/format"

import {
  useDayState,
  useDayStateFallback,
  type DayStateStore,
} from "./day-state-store"
import { StockCodePicker } from "./stock-code-picker"
import type { StockCodeList } from "./use-stock-code-list"

const CELL = "h-7 px-1.5 whitespace-nowrap tabular-nums"

const CHANGE_TONE = {
  up: "text-up",
  down: "text-down",
  flat: "text-muted-foreground",
} as const

// Prices up to two decimals: an index's are fractional.
const price = (n: number) => plain(n, Number.isInteger(n) ? 0 : 2)

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
  const tone = state === undefined ? "" : CHANGE_TONE[direction(state.change)]
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
      {state === undefined ? (
        <td colSpan={5} className={cn(CELL, "text-muted-foreground")}>
          no data yet
        </td>
      ) : (
        <>
          <td className={cn(CELL, "text-right", tone)}>{price(state.last)}</td>
          <td className={cn(CELL, "text-right", tone)}>
            {signed(state.change, Number.isInteger(state.change) ? 0 : 2)}{" "}
            <span className="text-[11px]">{pct(state.changePercent)}</span>
          </td>
          <td className={cn(CELL, "text-right")}>{compact(state.value)}</td>
          <td className={cn(CELL, "text-right")}>{compact(state.volume)}</td>
          <td className={cn(CELL, "text-right")}>{plain(state.frequency)}</td>
        </>
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
  return (
    <section aria-label="Watchlist" className="flex flex-col gap-2">
      <header className="flex items-center gap-3">
        <h2 className="text-sm font-semibold">Watchlist</h2>
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
        <table className="w-full text-[12px]">
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
