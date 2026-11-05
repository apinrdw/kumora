import { cn } from "@workspace/ui/lib/utils"

import {
  CONFIDENCE_TOOLTIP,
  Delta,
  KBadge,
  KDataTable,
  kFocus,
} from "@/components/k"
import type { KBadgeTone, KColumn, KSort } from "@/components/k"
import type { Signal } from "@/domain/signal"
import { compactIdr, idr, plain } from "@/lib/format"
import type { CandidateRow } from "./model"

const SIGNAL_BADGE = {
  accumulation: { tone: "accent", label: "Akumulasi" },
  distribution: { tone: "warning", label: "Distribusi" },
  mixed: { tone: "info", label: "Campuran" },
  neutral: { tone: "neutral", label: "Netral" },
  insufficient: { tone: "neutral", label: "Data belum cukup" },
} as const satisfies Record<Signal, { tone: KBadgeTone; label: string }>

function SignalBadge({ signal }: { signal: Signal }) {
  const b = SIGNAL_BADGE[signal]
  return <KBadge tone={b.tone}>{b.label}</KBadge>
}

const volx = (v: number) => `${plain(v, 1)}×`
const conf = (v: number | null) => (v == null ? "—" : `${v}/100`)

function columns(timeframe: string): ReadonlyArray<KColumn<CandidateRow>> {
  return [
    {
      key: "symbol",
      label: "Ticker",
      sortable: true,
      cell: (r) => (
        <span className="num font-[650] text-foreground">
          {r.symbol}
          <span
            title={r.name}
            className="text-secondary-text block max-w-[100px] truncate font-sans text-[11px] leading-[14px] font-normal"
          >
            {r.name}
          </span>
        </span>
      ),
    },
    { key: "last", label: "Last", cell: "idr", sortable: true },
    {
      key: "change",
      label: `Δ% ${timeframe}`,
      cell: "pct",
      sortable: true,
      description: `Perubahan harga ${timeframe} vs penutupan sebelumnya`,
    },
    {
      key: "volx",
      label: "Volume vs Avg",
      align: "right",
      sortable: true,
      cell: (r) => <span className="num">{volx(r.volx)}</span>,
      description: "Volume hari ini dibagi rata-rata 20 hari",
    },
    {
      key: "flow",
      label: "Flow",
      cell: "compactIdr",
      sortable: true,
      description: "Net broker flow (EOD 22 Okt), bukan intraday",
    },
    {
      key: "ai",
      label: "Indikasi AI",
      cell: (r) => <SignalBadge signal={r.ai} />,
    },
    {
      key: "confidence",
      label: "Keyakinan pola",
      align: "right",
      sortable: true,
      cell: (r) => <span className="num">{conf(r.confidence)}</span>,
      description: CONFIDENCE_TOOLTIP,
    },
    { key: "updated", label: "Updated", cell: "asOf" },
  ]
}

export function CandidateTable({
  rows,
  timeframe,
  sort,
  onSort,
  selected,
  onSelect,
}: {
  /** Already sorted: the table runs controlled. */
  rows: ReadonlyArray<CandidateRow>
  timeframe: string
  sort: KSort<CandidateRow>
  onSort: (sort: KSort<CandidateRow>) => void
  selected?: string
  onSelect: (row: CandidateRow) => void
}) {
  return (
    <div className="min-w-0">
      <KDataTable
        label="Kandidat Whale Radar (DATA DEMO)"
        columns={columns(timeframe)}
        rows={rows}
        getRowId={(r) => r.symbol}
        sort={sort}
        onSort={onSort}
        stickyFirst
        selectedId={selected}
        onRowClick={onSelect}
        className="[&_td]:px-2 [&_th]:px-2 [&_th]:leading-[14px] [&_th]:whitespace-normal"
      />
    </div>
  )
}

export function CandidateCards({
  rows,
  selected,
  onSelect,
}: {
  rows: ReadonlyArray<CandidateRow>
  selected?: string
  onSelect: (row: CandidateRow) => void
}) {
  return (
    <ul
      aria-label="Kandidat Whale Radar (DATA DEMO)"
      className="flex flex-col gap-2"
    >
      {rows.map((r) => (
        <li key={r.symbol}>
          <button
            type="button"
            aria-pressed={selected === r.symbol}
            onClick={() => onSelect(r)}
            className={cn(
              "bg-surface flex w-full flex-col gap-2 rounded-md border border-border px-4 py-3 text-left",
              "aria-pressed:bg-selected aria-pressed:border-primary",
              kFocus
            )}
          >
            <span className="flex items-center gap-2">
              <b className="num text-base font-[650]">{r.symbol}</b>
              <span className="text-secondary-text min-w-0 flex-1 truncate text-xs">
                {r.name}
              </span>
              <Delta value={r.change} className="text-[13px] font-medium" />
            </span>
            <span className="flex items-center gap-2">
              <SignalBadge signal={r.ai} />
              <span className="num ml-auto text-xs text-foreground">
                <span className="font-sans text-muted-foreground">
                  Keyakinan pola{" "}
                </span>
                {conf(r.confidence)}
              </span>
            </span>
            <span className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
              <Stat label="Last" value={idr(r.last)} />
              <Stat label="Vol vs avg" value={volx(r.volx)} />
              <Stat
                label="Flow (EOD)"
                value={r.flow == null ? "—" : compactIdr(r.flow)}
                className={
                  r.flow == null
                    ? undefined
                    : r.flow > 0
                      ? "text-up"
                      : "text-down"
                }
              />
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function Stat({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <span>
      {label}
      <b
        className={cn(
          "num block text-[13px] font-medium text-foreground",
          className
        )}
      >
        {value}
      </b>
    </span>
  )
}
