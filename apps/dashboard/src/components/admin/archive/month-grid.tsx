// The year × month grid an archive admin page's month cards share: one row
// per year, a mark per month, blank where there is none; and its month × day
// grid, for a kind published by the trading day. Each kind of mark
// differs in shape as well as color, and a legend names each. A grid with
// a detail panel makes each mark a button that selects its month.
import type { IconCheck } from "@tabler/icons-react"
import { cn } from "@workspace/ui/lib/utils"
import { type ReactNode, useState } from "react"

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

const MONTH_COLUMNS = MONTHS.map((month, i) => ({
  abbr: month,
  header: String(i + 1).padStart(2, "0"),
}))

const DAY_COLUMNS = Array.from({ length: 31 }, (_, i) => ({
  abbr: `Day ${i + 1}`,
  header: String(i + 1).padStart(2, "0"),
}))

export interface MarkStyle {
  readonly label: string
  readonly className: string
  readonly Icon: typeof IconCheck | null
}

function Mark({ style: { className, Icon } }: { style: MarkStyle }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-[18px] items-center justify-center rounded-[3px] border",
        className
      )}
    >
      {Icon && <Icon className="size-3" stroke={2.5} />}
    </span>
  )
}

function MarkWithLabel({ style }: { style: MarkStyle }) {
  return (
    <>
      <Mark style={style} />
      <span className="sr-only">{style.label}</span>
    </>
  )
}

// A month's mark as a button: a press selects its month, and pressing the
// selected month again clears the selection.
// Its hit area is 24px, 3px past the 18px mark on each side, the
// WCAG 2.2 AA minimum: twelve 44px targets don't fit a 390px phone's row,
// and the 4px border spacing keeps neighbouring areas from overlapping.
function SelectableMark({
  style,
  label,
  pressed,
  onToggle,
}: {
  style: MarkStyle
  label: string | undefined
  pressed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onToggle}
      className={cn(
        "relative flex cursor-pointer rounded-[4px] outline-offset-1 transition-transform duration-150 before:absolute before:-inset-[3px] before:content-[''] hover:scale-110 focus-visible:outline-2 focus-visible:outline-ring active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100",
        pressed && "outline-2 outline-foreground"
      )}
    >
      <MarkWithLabel style={style} />
    </button>
  )
}

export function MarkLegend({ styles }: { styles: ReadonlyArray<MarkStyle> }) {
  return (
    <ul
      aria-label="Legend"
      className="text-secondary-text flex flex-wrap gap-x-5 gap-y-2 text-[13px] leading-5"
    >
      {styles.map((style) => (
        <li key={style.label} className="flex items-center gap-2">
          <Mark style={style} />
          {style.label}
        </li>
      ))}
    </ul>
  )
}

// A table of marks, its columns' cells under a header each, one row per
// `rows`, selectable when it has a `detail`. A cell is named by its row's
// `name`, as `August 2026`, in its tooltip and its detail.
function MarkTable<Cell>({
  title,
  label,
  rowHeader,
  columns,
  rows,
  mark,
  describe,
  detail,
  empty,
}: {
  title: ReactNode
  label: string
  // What a row is, for a screen reader: Year or Month.
  rowHeader: string
  columns: ReadonlyArray<{ readonly abbr: string; readonly header: string }>
  rows: ReadonlyArray<{
    readonly key: string
    readonly header: string
    readonly cells: ReadonlyArray<Cell | null>
    readonly name: (index: number) => string
  }>
  mark: (cell: Cell) => MarkStyle
  describe?: (cell: Cell) => string
  detail?: (cell: Cell, name: string) => ReactNode
  empty?: string
}) {
  // Selected by position (row, cell index), not by the cell's value, so a
  // cell stays selected when the page reloads its data.
  const [selected, setSelected] = useState<{ row: string; index: number }>()
  const selectedRow = rows.find(({ key }) => key === selected?.row)
  const selectedCell =
    selected === undefined ? null : (selectedRow?.cells[selected.index] ?? null)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-[15px] leading-6 font-semibold">{title}</h3>
      {rows.length === 0 && empty !== undefined ? (
        <p className="text-secondary-text border-strong rounded-sm border border-dashed px-4 py-6 text-center text-sm leading-5 text-pretty">
          {empty}
        </p>
      ) : (
        // Scrolls inside the card, never the page, if a screen is narrower.
        <div className="overflow-x-auto">
          <table
            aria-label={label}
            className="border-separate border-spacing-1"
          >
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">{rowHeader}</span>
                </th>
                {columns.map(({ abbr, header }) => (
                  <th
                    key={abbr}
                    scope="col"
                    abbr={abbr}
                    className="font-data text-secondary-text w-[18px] text-center text-[11px] font-medium"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ key, header, cells, name }) => (
                <tr key={key}>
                  <th
                    scope="row"
                    className="font-data text-secondary-text pr-2 text-left text-[11px] font-medium whitespace-nowrap"
                  >
                    {header}
                  </th>
                  {columns.map(({ abbr }, i) => {
                    const cell = cells[i] ?? null
                    const style = cell === null ? undefined : mark(cell)
                    const note = cell === null ? undefined : describe?.(cell)
                    const tooltip =
                      cell === null || style === undefined
                        ? undefined
                        : `${name(i)}: ${style.label}${note ? ` ${note}` : ""}`
                    const pressed =
                      selected?.row === key && selected.index === i
                    return (
                      <td key={abbr} title={tooltip}>
                        {style &&
                          (detail === undefined ? (
                            <MarkWithLabel style={style} />
                          ) : (
                            <SelectableMark
                              style={style}
                              label={tooltip}
                              pressed={pressed}
                              onToggle={() =>
                                setSelected(
                                  pressed ? undefined : { row: key, index: i }
                                )
                              }
                            />
                          ))}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail !== undefined &&
        selected !== undefined &&
        selectedCell !== null &&
        detail(selectedCell, selectedRow?.name(selected.index) ?? "")}
    </div>
  )
}

/**
 * `years`, oldest first, each with its months from January; a month that is
 * null, or past the end of its year's list, is blank. `mark` styles a month,
 * and `describe` adds to its tooltip after the month and its mark's label.
 * With `detail`, clicking or tapping a month selects it, nothing at first,
 * and `detail` renders the selected month, named like `August 2026`, under
 * the grid. With no years, `empty` shows under the title instead of the
 * grid.
 */
export function MonthGrid<Month>({
  years,
  ...table
}: {
  title: ReactNode
  label: string
  years: ReadonlyArray<{
    readonly year: number
    readonly months: ReadonlyArray<Month | null>
  }>
  mark: (month: Month) => MarkStyle
  describe?: (month: Month) => string
  detail?: (month: Month, name: string) => ReactNode
  empty?: string
}) {
  return (
    <MarkTable
      {...table}
      rowHeader="Year"
      columns={MONTH_COLUMNS}
      rows={years.map(({ year, months }) => ({
        key: String(year),
        header: String(year),
        cells: months,
        name: (index) => `${MONTHS[index]} ${year}`,
      }))}
    />
  )
}

/**
 * `months`, oldest first, each a month (YYYY-MM) with its days from the 1st;
 * a day that is null, or past the end of its month's list, is blank. As
 * MonthGrid, with a day named like `20 November 2026`.
 */
export function DayGrid<Day>({
  months,
  ...table
}: {
  title: ReactNode
  label: string
  months: ReadonlyArray<{
    readonly month: string
    readonly days: ReadonlyArray<Day | null>
  }>
  mark: (day: Day) => MarkStyle
  describe?: (day: Day) => string
  detail?: (day: Day, name: string) => ReactNode
  empty?: string
}) {
  return (
    <MarkTable
      {...table}
      rowHeader="Month"
      columns={DAY_COLUMNS}
      rows={months.map(({ month, days }) => {
        const year = month.slice(0, 4)
        const name = MONTHS[Number(month.slice(5, 7)) - 1] ?? month
        return {
          key: month,
          header: `${name.slice(0, 3)} ${year}`,
          cells: days,
          name: (index) => `${index + 1} ${name} ${year}`,
        }
      })}
    />
  )
}
