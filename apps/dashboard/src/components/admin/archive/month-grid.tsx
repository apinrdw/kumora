// The year × month grid an archive admin page's month cards share: one row
// per year, a mark per month, blank where there is none. Each kind of mark
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
        "flex cursor-pointer rounded-[4px] outline-offset-1 focus-visible:outline-2 focus-visible:outline-ring",
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
      className="text-secondary-text flex flex-wrap gap-x-4 gap-y-1 text-[13px]"
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

/**
 * `years`, oldest first, each with its months from January; a month that is
 * null, or past the end of its year's list, is blank. `mark` styles a month,
 * and `describe` adds to its tooltip after the month and its mark's label.
 * With `detail`, clicking or tapping a month selects it, nothing at first,
 * and `detail` renders the selected month, named like `August 2026`, under
 * the grid.
 */
export function MonthGrid<Month>({
  title,
  label,
  years,
  mark,
  describe,
  detail,
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
}) {
  // By position, so a month stays selected when the page reloads its data.
  const [selected, setSelected] = useState<{ year: number; index: number }>()
  const selectedYear = years.find(({ year }) => year === selected?.year)
  const selectedMonth =
    selected === undefined
      ? null
      : (selectedYear?.months[selected.index] ?? null)
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {/* Scrolls inside the card, never the page, if a screen is narrower. */}
      <div className="overflow-x-auto">
        <table aria-label={label} className="border-separate border-spacing-1">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Year</span>
              </th>
              {MONTHS.map((month, i) => (
                <th
                  key={month}
                  scope="col"
                  abbr={month}
                  className="num w-[18px] text-center text-[11px] font-medium text-muted-foreground"
                >
                  {String(i + 1).padStart(2, "0")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {years.map(({ year, months }) => (
              <tr key={year}>
                <th
                  scope="row"
                  className="num pr-1 text-left text-[11px] font-medium text-muted-foreground"
                >
                  {year}
                </th>
                {MONTHS.map((name, i) => {
                  const month = months[i] ?? null
                  const style = month === null ? undefined : mark(month)
                  const tooltip =
                    month === null || style === undefined
                      ? undefined
                      : `${name} ${year}: ${style.label}${describe ? ` ${describe(month)}` : ""}`
                  const pressed =
                    selected?.year === year && selected.index === i
                  return (
                    <td key={name} title={tooltip}>
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
                                pressed ? undefined : { year, index: i }
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
      {detail !== undefined &&
        selected !== undefined &&
        selectedMonth !== null &&
        detail(selectedMonth, `${MONTHS[selected.index]} ${selected.year}`)}
    </div>
  )
}
