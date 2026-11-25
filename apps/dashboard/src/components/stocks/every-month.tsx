// The Major holders panel's Every month grid, below its table (spec
// apinrdw/kumora#479, "Major holders panel"; apinrdw/kumora#474's
// amendment): holders × every above-1% month, the panel's month outlined.
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import type { CSSProperties } from "react"

import { BoundedRows, ROWS_SHOWN } from "@/components/k/bounded-rows"
import { MOVEMENT } from "@/components/stocks/holder-movement"
import { everyMonth } from "@/lib/every-month"
import { lotsOfShares, plain } from "@/lib/format"
import { shortMonth } from "@/lib/stock-page-display"
import type { MajorHoldersMonth } from "@/server/holdings/stock-page"

// Each move's mark, worded and coloured as the table's chip for it.
const MARK = {
  up: {
    text: "▲",
    label: `${MOVEMENT.up.label} from the month before`,
    className: MOVEMENT.up.text,
  },
  down: {
    text: "▼",
    label: `${MOVEMENT.down.label} from the month before`,
    className: MOVEMENT.down.text,
  },
  return: {
    text: "•",
    label: `${MOVEMENT.new.label}, back after a month not listed`,
    className: MOVEMENT.new.text,
  },
} as const

// A cell's tint, as strong as its `--shade`.
const SHADE =
  "bg-[color-mix(in_oklab,var(--semantic-info)_var(--shade),transparent)]"

// The cells the grid's server render holds: its rows are as many as fit, so
// a grid of many months renders fewer rows there.
const CELLS_SHOWN = 6_000

const OUTLINE = "data-selected:shadow-[inset_0_0_0_1.5px_var(--text-primary)]"

export function EveryMonth({
  months,
  selected,
}: {
  months: ReadonlyArray<MajorHoldersMonth>
  // The panel's month's data date.
  selected: string
}) {
  const { rows, cellsOf, largest } = Effect.runSync(
    everyMonth(months, selected)
  )
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-[13px] font-semibold">Every month</h3>
        <p className="text-[12px] text-muted-foreground">
          % of listed shares. A dot is a month the holder was not listed: sold
          out or fell below 1%. A small dot marks a holder back on the list. The
          selected month is outlined.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table
          aria-label="Every month"
          className="w-full text-[12px] [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1 [&_tr]:border-b [&_tr]:border-border"
        >
          <thead className="[&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-muted-foreground">
            <tr>
              <th scope="col" className="text-left">
                Holder
              </th>
              {months.map(({ dataDate }) => (
                <th
                  key={dataDate}
                  scope="col"
                  aria-current={dataDate === selected || undefined}
                  className={cn(
                    "text-right",
                    dataDate === selected && "text-foreground"
                  )}
                >
                  {Effect.runSync(shortMonth(dataDate))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <BoundedRows
              rows={rows}
              bound={Math.max(
                1,
                Math.min(ROWS_SHOWN, Math.floor(CELLS_SHOWN / months.length))
              )}
            >
              {(row) => (
                <tr
                  key={row.holder}
                  data-unlisted={!row.listed || undefined}
                  className={cn(!row.listed && "text-muted-foreground")}
                >
                  <th
                    scope="row"
                    className="max-w-56 text-left font-normal [overflow-wrap:anywhere]"
                  >
                    {row.name}
                  </th>
                  {Effect.runSync(cellsOf(row.holder)).map((cell, index) => {
                    const outlined = months[index]?.dataDate === selected
                    if (cell === undefined)
                      return (
                        <td
                          key={index}
                          title="Not listed"
                          data-selected={outlined || undefined}
                          className={cn(
                            "text-center text-muted-foreground",
                            OUTLINE
                          )}
                        >
                          ·
                        </td>
                      )
                    const mark = cell.move && MARK[cell.move]
                    return (
                      <td
                        key={index}
                        title={`${Effect.runSync(lotsOfShares(cell.shares))} lots`}
                        data-selected={outlined || undefined}
                        className={cn(
                          "num text-right whitespace-nowrap",
                          SHADE,
                          OUTLINE
                        )}
                        style={
                          {
                            "--shade": `${Math.round(8 + (50 * cell.hundredths) / largest)}%`,
                          } as CSSProperties
                        }
                      >
                        {Effect.runSync(plain(cell.hundredths / 100, 2))}
                        {mark && (
                          <span
                            title={mark.label}
                            className={cn("ml-0.5", mark.className)}
                          >
                            {mark.text}
                          </span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )}
            </BoundedRows>
          </tbody>
        </table>
      </div>
    </div>
  )
}
