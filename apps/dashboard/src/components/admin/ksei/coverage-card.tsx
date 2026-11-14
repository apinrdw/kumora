import { IconCheck, IconX } from "@tabler/icons-react"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { ArchiveCard } from "@/components/admin/archive/archive-card"
import { dateTime } from "@/lib/format"
import type { ArchiveRunId } from "@/server/archive/run"
import type { CoverageState, KseiCoverage } from "@/server/ksei/coverage"
import { KIND_LABEL } from "@/server/ksei/kind"

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

// Each state differs in shape as well as color: a filled square with a
// check, an outlined square with a cross, an empty dashed square.
const STATE = {
  held: {
    label: "Held",
    className: "border-up/70 bg-up/25 text-up",
    Icon: IconCheck,
  },
  "not-found": {
    label: "Not found",
    className: "border-down/80 text-down",
    Icon: IconX,
  },
  "never-looked-for": {
    label: "Never looked for",
    className: "border-dashed border-strong",
    Icon: null,
  },
} as const satisfies Record<
  CoverageState,
  { label: string; className: string; Icon: typeof IconCheck | null }
>

function Mark({ state }: { state: CoverageState }) {
  const { className, Icon } = STATE[state]
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

function KindGrid({ kind, years }: KseiCoverage[number]) {
  const label = `${KIND_LABEL[kind]} coverage`
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-[13px] font-semibold">{KIND_LABEL[kind]}</h3>
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
                {MONTHS.map((month, i) => {
                  const state = months[i]
                  return (
                    <td
                      key={month}
                      title={state && `${month} ${year}: ${STATE[state].label}`}
                    >
                      {state && (
                        <>
                          <Mark state={state} />
                          <span className="sr-only">{STATE[state].label}</span>
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

/**
 * Each KSEI report kind's months from 2008: held, not found by the latest
 * Deep backfill, or never looked for.
 */
export function KseiCoverageCard({
  coverage,
  lastDeepRun,
}: {
  coverage: KseiCoverage
  lastDeepRun:
    | { readonly id: ArchiveRunId; readonly finishedAt: string | null }
    | undefined
}) {
  return (
    <ArchiveCard title="Coverage" aside={null}>
      <ul
        aria-label="Legend"
        className="text-secondary-text flex flex-wrap gap-x-4 gap-y-1 text-[13px]"
      >
        {(Object.keys(STATE) as Array<CoverageState>).map((state) => (
          <li key={state} className="flex items-center gap-2">
            <Mark state={state} />
            {STATE[state].label}
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-muted-foreground">
        {lastDeepRun === undefined ? (
          "No Deep backfill has run yet, so no month without a KSEI report has been looked for."
        ) : (
          <>
            Not found by the latest Deep backfill,{" "}
            <span className="font-mono whitespace-nowrap">
              {lastDeepRun.id}
            </span>
            {lastDeepRun.finishedAt !== null &&
              `, finished ${Effect.runSync(dateTime(lastDeepRun.finishedAt))}`}
            .
          </>
        )}
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        {coverage.map((kind) => (
          <KindGrid key={kind.kind} {...kind} />
        ))}
      </div>
    </ArchiveCard>
  )
}
