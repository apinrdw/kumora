// The year × month grid an archive admin page's month cards share: one row
// per year, a mark per month, blank where there is none. Each kind of mark
// differs in shape as well as color, and a legend names each.
import type { IconCheck } from "@tabler/icons-react"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

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
 */
export function MonthGrid<Month>({
  title,
  label,
  years,
  mark,
  describe,
}: {
  title: ReactNode
  label: string
  years: ReadonlyArray<{
    readonly year: number
    readonly months: ReadonlyArray<Month | null>
  }>
  mark: (month: Month) => MarkStyle
  describe?: (month: Month) => string
}) {
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
                  return (
                    <td
                      key={name}
                      title={
                        month === null || style === undefined
                          ? undefined
                          : `${name} ${year}: ${style.label}${describe ? ` ${describe(month)}` : ""}`
                      }
                    >
                      {style && (
                        <>
                          <Mark style={style} />
                          <span className="sr-only">{style.label}</span>
                        </>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
