import { useNavigate, useSearch } from "@tanstack/react-router"
import { useRef, useState } from "react"

import { KEmptyState, KStatusPill, sortRows } from "@/components/k"
import type { KSort } from "@/components/k"
import { asOf } from "@/lib/format"
import { CandidateCards, CandidateTable } from "./candidate-list"
import { EvidencePanel } from "./evidence-panel"
import { FilterBar } from "./filter-bar"
import {
  ANOMALY_VOLX,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  matches,
  toRow,
} from "./model"
import type { CandidateRow, Filters } from "./model"
import type { Candidate, RadarSnapshot } from "./schema"
import { SweepFeed } from "./sweep-feed"

export function RadarPage({ snapshot }: { snapshot: RadarSnapshot }) {
  const { candidates } = snapshot
  const search = useSearch({ from: "/radar" })
  const navigate = useNavigate({ from: "/radar" })

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [sort, setSort] = useState<KSort<CandidateRow>>(DEFAULT_SORT)
  const panelRef = useRef<HTMLElement>(null)

  const visible = candidates.filter((c) => matches(c, filters))
  const rows = sortRows(
    visible.map((c) => toRow(c, filters.timeframe)),
    sort
  )
  const anomalyCount = candidates.filter(
    (c) =>
      c.volx >= ANOMALY_VOLX && matches(c, { ...filters, volumeAnomaly: false })
  ).length

  const selected: Candidate | undefined =
    candidates.find((c) => c.symbol === search.t) ??
    candidates.find((c) => c.symbol === rows[0]?.symbol)

  function select(row: CandidateRow) {
    void navigate({
      search: (s) => ({ ...s, t: row.symbol }),
      replace: true,
      resetScroll: false,
    })
    if (window.matchMedia("(max-width: 1439px)").matches) {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }

  const resetFilters = () => setFilters(DEFAULT_FILTERS)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-2xl leading-8 font-bold">Whale Radar</h1>
        <span className="num flex items-center gap-2 text-xs text-muted-foreground sm:ml-auto">
          {rows.length} kandidat · per {asOf(snapshot.asOf)}
          <KStatusPill status="demo" asOf={snapshot.asOf} hideAsOf />
        </span>
      </div>

      <SweepFeed today={snapshot.whales} />

      <FilterBar
        filters={filters}
        onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
        onReset={resetFilters}
        anomalyCount={anomalyCount}
      />

      <div className="grid items-start gap-4 min-[1440px]:grid-cols-[minmax(0,1fr)_340px]">
        <section
          aria-label="Daftar kandidat"
          className="flex min-w-0 flex-col gap-2"
        >
          {rows.length === 0 ? (
            <KEmptyState
              kind="no-result"
              action={{ label: "Reset filter", onClick: resetFilters }}
              className="max-w-none"
            />
          ) : (
            <>
              <div className="hidden md:block">
                <CandidateTable
                  rows={rows}
                  timeframe={filters.timeframe}
                  sort={sort}
                  onSort={setSort}
                  selected={selected?.symbol}
                  onSelect={select}
                />
              </div>
              <div className="md:hidden">
                <CandidateCards
                  rows={rows}
                  selected={selected?.symbol}
                  onSelect={select}
                />
              </div>
            </>
          )}
          <p className="text-xs leading-[18px] text-muted-foreground">
            Daftar ini adalah kandidat pola, bukan peringkat saham yang pasti
            naik. Keyakinan pola mengukur klasifikasi pola, bukan peluang
            untung. Flow bersumber dari feed broker EOD (22 Okt). DATA DEMO.
          </p>
        </section>

        <aside
          ref={panelRef}
          aria-label="Bukti kandidat"
          className="scroll-mt-16 min-[1440px]:sticky min-[1440px]:top-[124px]"
        >
          <EvidencePanel snapshot={snapshot} candidate={selected} />
        </aside>
      </div>
    </div>
  )
}
