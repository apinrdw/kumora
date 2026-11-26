import { clientRuntime, type StockCode } from "@workspace/client"
import {
  standoutKey,
  type StandoutLevel,
  type StandoutSweep,
  type WibDate,
} from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { DateTime, Effect } from "effect"
import { memo, useMemo, useSyncExternalStore } from "react"

import { compact, lots, plain, tapeTime } from "@/lib/format"
import { pricePath } from "@/lib/sweeps"
import { makeStoredValue } from "@/lib/stored-value"

import type { StandoutStore } from "./standout-store"

const LEVELS: ReadonlyArray<StandoutLevel> = [1, 5, 10]

// Decision: each browser keeps its own settings in localStorage
// (apps/dashboard/docs/adr/0021-each-browser-keeps-its-own-settings-in-localstorage.md)
const KEY = "kumora:market-live:standout-level"

// Anything but a stored 5 or 10 reads as 1%, which lists the sweeps that
// alert.
const levelSetting = Effect.runSync(
  makeStoredValue<StandoutLevel>({
    key: KEY,
    parse: (raw) => Effect.succeed(raw === "5" ? 5 : raw === "10" ? 10 : 1),
    serialize: (level) => Effect.succeed(level === 1 ? null : String(level)),
  })
)

const SIDE = {
  buy: { label: "Buy", tone: "text-up" },
  sell: { label: "Sell", tone: "text-down" },
} as const

const COLUMNS = "grid-cols-[58px_40px_34px_minmax(0,1fr)_64px]"

const StandoutRow = memo(function StandoutRow({
  row,
  onSelect,
}: {
  row: StandoutSweep
  onSelect: (code: StockCode) => void
}) {
  const { sweep } = row
  // The rule never ranks an auction match, so a standout sweep has a side.
  const side = SIDE[sweep.side === "sell" ? "sell" : "buy"]
  return (
    <li>
      <button
        type="button"
        data-code={row.code}
        data-side={sweep.side}
        data-level={row.level}
        title={`${row.code} · top ${row.level}% · ${sweep.trades} trades`}
        onClick={() => onSelect(row.code)}
        className={cn(
          "hover:bg-elevated grid h-6 w-full items-center gap-1.5 px-2.5 text-left font-mono text-[12px] whitespace-nowrap",
          COLUMNS
        )}
      >
        <span>
          {Effect.runSync(tapeTime(DateTime.toEpochMillis(sweep.time)))}
        </span>
        <span className="font-semibold">{row.code}</span>
        <span className={side.tone}>{side.label}</span>
        <span className="truncate">
          {Effect.runSync(lots(sweep.lots))} @{" "}
          {Effect.runSync(pricePath(sweep))}
        </span>
        <span className="text-right">
          Rp{Effect.runSync(compact(sweep.value))}
        </span>
      </button>
    </li>
  )
})

/**
 * The All codes tab (spec apinrdw/kumora#705): the standout sweeps of every
 * stock code the live page heard, newest first, at or under the level the
 * picker keeps for this browser. Clicking a row selects its code.
 */
function AllCodes({
  store,
  onSelect,
}: {
  store: StandoutStore
  onSelect: (code: StockCode) => void
}) {
  const level = useSyncExternalStore(
    levelSetting.subscribe,
    levelSetting.snapshot,
    () => 1 as const
  )
  const all = useSyncExternalStore(store.subscribe, store.rows, store.rows)
  const rows = useMemo(
    () => all.filter((row) => row.level <= level),
    [all, level]
  )
  // `contain: size`, as the sweep log: the list scrolls inside its
  // column rather than stretching the charts beside it.
  return (
    <section
      aria-label="All codes"
      className="flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card contain-size"
    >
      <header className="border-b border-border px-2.5 pt-2 pb-1.5">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
          <h2>Standout sweeps · All codes</h2>
          <div
            role="radiogroup"
            aria-label="Standout level"
            className="ml-auto flex gap-0.5 text-[11px] font-normal"
          >
            {LEVELS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={option === level}
                onClick={() =>
                  clientRuntime.runSync(levelSetting.write(option))
                }
                className={cn(
                  "rounded-md border border-border px-1.5 py-px tabular-nums",
                  option === level
                    ? "border-primary text-primary"
                    : "hover:bg-elevated"
                )}
              >
                {option}%
              </button>
            ))}
          </div>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
          Top {level}% of each code's sweeps by side ·{" "}
          <span aria-label="Rows shown">
            showing {Effect.runSync(plain(rows.length))}
          </span>
        </p>
      </header>
      <div
        aria-hidden
        className={cn(
          "grid gap-1.5 border-b border-border px-2.5 py-1 text-[10px] tracking-[0.06em] text-muted-foreground uppercase",
          COLUMNS
        )}
      >
        <span>Time</span>
        <span>Code</span>
        <span>Side</span>
        <span>Lots @ price</span>
        <span className="text-right">Value</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-2.5 py-2 text-[12px] text-muted-foreground">
            No standout sweeps yet. A code lists once a side has 100 sweeps
            today.
          </p>
        ) : (
          <ol aria-label="Standout sweeps, newest first">
            {rows.map((row) => (
              <StandoutRow
                key={standoutKey(row)}
                row={row}
                onSelect={onSelect}
              />
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}

// The All codes tab over the page's standout store: none on a recorded
// day (`day`) or for an index, which have no live standout sweeps to list.
export const allCodesTab = ({
  store,
  day,
  index,
  onSelect,
}: {
  store: StandoutStore
  day: WibDate | undefined
  index: boolean
  onSelect: (code: StockCode) => void
}) =>
  day === undefined && !index ? (
    <AllCodes store={store} onSelect={onSelect} />
  ) : undefined
