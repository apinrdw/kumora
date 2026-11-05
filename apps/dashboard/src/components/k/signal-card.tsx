import {
  IconAlertTriangle,
  IconBell,
  IconDatabase,
  IconInfoCircle,
  IconMinus,
  IconPlus,
  IconRadar,
  IconRobot,
  IconWaveSine,
} from "@tabler/icons-react"
import type { TablerIcon } from "@tabler/icons-react"
import { Card } from "@workspace/ui/components/card"
import { Progress } from "@workspace/ui/components/progress"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

import type { Freshness } from "@/domain/freshness"
import type { Evidence, Signal } from "@/domain/signal"
import { asOf as formatAsOf } from "@/lib/format"
import { KButton } from "./button"
import { KStatusPill } from "./status-pill"
import { kCard, kFocus } from "./styles"
import { KTooltip } from "./tooltip"

export const SIGNAL = {
  accumulation: {
    title: "Indikasi akumulasi terdeteksi",
    Icon: IconRadar,
    className: "text-primary",
  },
  distribution: {
    title: "Indikasi distribusi terdeteksi",
    Icon: IconAlertTriangle,
    className: "text-warning",
  },
  mixed: {
    title: "Sinyal campuran — perlu konfirmasi",
    Icon: IconWaveSine,
    className: "text-neutral",
  },
  neutral: {
    title: "Belum ada arah yang jelas",
    Icon: IconMinus,
    className: "text-neutral",
  },
  insufficient: {
    title: "Data belum cukup",
    Icon: IconInfoCircle,
    className: "text-muted-foreground",
  },
} as const satisfies Record<
  Signal,
  { title: string; Icon: TablerIcon; className: string }
>

export const CONFIDENCE_TOOLTIP =
  "Skor ini mengukur keyakinan klasifikasi pola, bukan kemungkinan untung."

export type KSignalCardProps = {
  ticker: string
  name?: string
  signal: Signal
  /** 0–100 classifier certainty, NOT a probability of profit. Ignored for `insufficient`. */
  confidenceScore?: number | null
  evidence?: ReadonlyArray<Evidence>
  counterEvidence?: ReadonlyArray<string>
  modelVersion?: string
  /** ISO datetime. */
  computedAt?: string
  freshness: Freshness
  /** ISO datetime. */
  asOf?: string
  onAddWatchlist?: () => void
  onCreateAlert?: () => void
  className?: string
}

type Details = Omit<
  KSignalCardProps,
  "ticker" | "signal" | "confidenceScore" | "freshness" | "className"
>

function ConfidenceMeter({ score }: { score: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-secondary-text flex justify-between text-xs leading-[18px]">
        <KTooltip
          explain
          title="Bukan peluang profit"
          content={CONFIDENCE_TOOLTIP}
        >
          <button
            type="button"
            className={cn(
              "inline-flex cursor-help items-center gap-1 rounded-xs",
              kFocus
            )}
          >
            Keyakinan pola
            <IconInfoCircle aria-hidden stroke={1.75} className="size-4" />
          </button>
        </KTooltip>
        <b className="num font-medium text-foreground">{score}/100</b>
      </div>
      {/* Meter is primary, never semantic-up: confidence is not profit. */}
      <Progress
        value={score}
        aria-label="Keyakinan klasifikasi pola"
        className="[&_[data-slot=progress-track]]:bg-elevated [&_[data-slot=progress-indicator]]:bg-primary [&_[data-slot=progress-track]]:rounded-xs"
      />
    </div>
  )
}

function ObservedEvidence({ evidence = [] }: Pick<Details, "evidence">) {
  if (evidence.length === 0) return null
  return (
    <EvidenceGroup icon={IconDatabase} label="Observed data">
      {evidence.map((e) => (
        <li
          key={e.label}
          title={[e.source, e.asOf && formatAsOf(e.asOf)]
            .filter(Boolean)
            .join(" · ")}
          className="flex justify-between gap-3"
        >
          <span>{e.label}</span>
          <span className="num whitespace-nowrap text-foreground">
            {e.value}
          </span>
        </li>
      ))}
    </EvidenceGroup>
  )
}

function CounterEvidence({
  counterEvidence = [],
}: Pick<Details, "counterEvidence">) {
  if (counterEvidence.length === 0) return null
  return (
    <EvidenceGroup icon={IconRobot} label="Bukti berlawanan" ai>
      {counterEvidence.map((c) => (
        <li key={c}>
          <span aria-hidden className="text-warning mr-1">
            —
          </span>
          {c}
        </li>
      ))}
    </EvidenceGroup>
  )
}

function ModelMeta({
  modelVersion,
  computedAt,
}: Pick<Details, "modelVersion" | "computedAt">) {
  if (!modelVersion && !computedAt) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs leading-[18px] text-muted-foreground">
      {modelVersion && <span>Model {modelVersion}</span>}
      {modelVersion && computedAt && <span aria-hidden>·</span>}
      {computedAt && (
        <span className="num">dihitung {formatAsOf(computedAt)}</span>
      )}
    </div>
  )
}

function SignalActions({
  onAddWatchlist,
  onCreateAlert,
}: Pick<Details, "onAddWatchlist" | "onCreateAlert">) {
  if (!onAddWatchlist && !onCreateAlert) return null
  return (
    <div className="flex flex-wrap gap-2">
      {onAddWatchlist && (
        <KButton
          variant="secondary"
          size="sm"
          icon={IconPlus}
          onClick={onAddWatchlist}
        >
          Tambah ke Watchlist
        </KButton>
      )}
      {onCreateAlert && (
        <KButton
          variant="ghost"
          size="sm"
          icon={IconBell}
          onClick={onCreateAlert}
        >
          Buat Alert
        </KButton>
      )}
    </div>
  )
}

/** AI inference card. No BUY/SELL actions, ever. */
export function KSignalCard({
  ticker,
  signal,
  confidenceScore,
  freshness,
  className,
  ...details
}: KSignalCardProps) {
  const copy = SIGNAL[signal]
  const showConfidence = signal !== "insufficient" && confidenceScore != null
  return (
    <Card
      role="article"
      aria-label={`${ticker} — ${copy.title}`}
      className={cn(
        kCard,
        "w-full gap-3",
        freshness === "stale" && "border-warning",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="num text-base leading-6 font-[650]">{ticker}</div>
          {details.name && (
            <div className="text-secondary-text text-xs leading-[18px]">
              {details.name}
            </div>
          )}
        </div>
        <KStatusPill status={freshness} asOf={details.asOf} />
      </div>

      <div
        className={cn(
          "flex items-center gap-2 text-sm leading-[22px] font-medium",
          copy.className
        )}
      >
        <copy.Icon aria-hidden stroke={1.75} className="size-4.5" />
        {copy.title}
      </div>

      {showConfidence && <ConfidenceMeter score={confidenceScore} />}
      <ObservedEvidence {...details} />
      <CounterEvidence {...details} />

      {signal === "insufficient" && (
        <p className="text-secondary-text text-[13px] leading-[18px]">
          Belum ada data yang cukup untuk periode ini. Model tidak memaksakan
          verdik.
        </p>
      )}

      <ModelMeta {...details} />
      <SignalActions {...details} />
    </Card>
  )
}

function EvidenceGroup({
  icon: Icon,
  label,
  ai = false,
  children,
}: {
  icon: TablerIcon
  label: string
  ai?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          "micro flex items-center gap-1",
          ai ? "text-info" : "text-muted-foreground"
        )}
      >
        <Icon aria-hidden stroke={1.75} className="size-4" />
        {label}
      </div>
      <ul className="text-secondary-text flex flex-col gap-0.5 text-[13px] leading-[18px]">
        {children}
      </ul>
    </div>
  )
}
