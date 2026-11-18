import { IconCheck, IconRefresh, IconX } from "@tabler/icons-react"
import { Effect } from "effect"
import type { ReactNode } from "react"

import { ArchiveCard } from "@/components/admin/archive/archive-card"
import {
  MarkLegend,
  type MarkStyle,
  MonthGrid,
} from "@/components/admin/archive/month-grid"
import { dateTime } from "@/lib/format"
import type {
  ParseCoverage,
  ParseCoverageMonth,
  ParseCoverageState,
  StaleCause,
} from "@/server/holdings/parse-coverage"

// Each state differs in shape as well as color: a filled square with a
// check, a filled square with a refresh arrow, an outlined square with a
// cross, an empty dashed square.
const STATE = {
  parsed: {
    label: "Parsed",
    className: "border-up/70 bg-up/25 text-up",
    Icon: IconCheck,
  },
  stale: {
    label: "Stale",
    className: "border-warning/70 bg-warning/20 text-warning",
    Icon: IconRefresh,
  },
  failed: {
    label: "Failed",
    className: "border-down/80 text-down",
    Icon: IconX,
  },
  "not-parsed": {
    label: "Not parsed yet",
    className: "border-dashed border-strong",
    Icon: null,
  },
} as const satisfies Record<ParseCoverageState, MarkStyle>

const STALE_CAUSE = {
  "newer-version": "newer version archived",
  "parser-updated": "parser updated",
} as const satisfies Record<StaleCause, string>

// A version's SHA-256, cut to its first 12 hex digits.
const shortSha = Effect.fnUntraced(function* (sha256: string) {
  return sha256.slice(0, 12)
})

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-secondary-text">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

// The selected month's detail, under its grid.
function MonthDetail({
  title,
  name,
  month: { date, state, newestSha256, parsed, staleCauses, failure },
}: {
  title: string
  name: string
  month: ParseCoverageMonth
}) {
  const causes = staleCauses.map((cause) => STALE_CAUSE[cause]).join(", ")
  return (
    <section
      aria-label={`${title} month detail`}
      className="bg-canvas/40 flex flex-col gap-3 rounded-sm border border-border px-4 py-3 text-sm leading-5"
    >
      <h4 className="text-[15px] leading-6 font-semibold">
        {name}{" "}
        <span className="font-data text-secondary-text text-[13px] font-normal">
          {date}
        </span>{" "}
        <span className="font-normal">{STATE[state].label}</span>
      </h4>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
        <Detail label="Newest version">
          <span className="font-data text-xs">
            {Effect.runSync(shortSha(newestSha256))}
          </span>
        </Detail>
        {parsed === null ? (
          <Detail label="Parsed holdings">No parsed holdings</Detail>
        ) : (
          <>
            <Detail label="Parsed from">
              <span className="font-data text-xs">
                {Effect.runSync(shortSha(parsed.sha256))}
              </span>
            </Detail>
            <Detail label="Parser version">{parsed.parserVersion}</Detail>
            <Detail label="Parsed at">
              {Effect.runSync(dateTime(parsed.parsedAt))}
            </Detail>
            <Detail label="Stocks">
              <span className="font-data">{parsed.stockCount}</span>
            </Detail>
          </>
        )}
        {state === "stale" && (
          <Detail label="Stale because">
            {causes.charAt(0).toUpperCase() + causes.slice(1)}
          </Detail>
        )}
        {failure !== null && (
          <>
            <Detail label="Failure">{failure.message}</Detail>
            <Detail label="Run">
              <span className="font-data text-xs">{failure.run}</span>
            </Detail>
          </>
        )}
      </dl>
    </section>
  )
}

/**
 * Each grid's kind, a Report kind or a KSEI report kind: every archived
 * month's parse coverage
 * (server/holdings/parse-coverage.ts), titled by the kind. Read-only: Parse
 * now on the parse run card parses every month not parsed. Selecting a
 * month shows its detail under its grid.
 */
export function ParseCoverageCard({
  grids,
}: {
  grids: ReadonlyArray<{ title: string; parseCoverage: ParseCoverage }>
}) {
  return (
    <ArchiveCard title="Parse coverage" aside={null}>
      <MarkLegend styles={Object.values(STATE)} />
      <div className="@container">
        <div className="grid gap-6 @2xl:grid-cols-2">
          {grids.map(({ title, parseCoverage }) => (
            <MonthGrid
              key={title}
              title={title}
              label={`${title} parse coverage`}
              years={parseCoverage}
              empty={`No ${title} report is archived yet.`}
              mark={({ state }) => STATE[state]}
              describe={({ date }) => `(${date})`}
              detail={(month, name) => (
                <MonthDetail title={title} name={name} month={month} />
              )}
            />
          ))}
        </div>
      </div>
    </ArchiveCard>
  )
}
