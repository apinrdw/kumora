import {
  IconClock,
  IconDatabase,
  IconSearch,
  IconAdjustmentsHorizontal,
} from "@tabler/icons-react"
import { Card } from "@workspace/ui/components/card"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

import type {
  AlertChannel,
  AlertIndicator,
  AlertOperator,
  AlertRule,
  AlertSession,
} from "@/domain/alert"
import type { FeedDependency } from "@/domain/freshness"
import { dateTime } from "@/lib/format"
import { KBadge } from "./badge"
import { KButton, KIconButton } from "./button"
import { KInput } from "./input"
import { KSelect } from "./select"
import type { KSelectOption } from "./select"
import { kCard, kFocus } from "./styles"

export const INDICATORS: ReadonlyArray<KSelectOption<AlertIndicator>> = [
  { value: "net_flow", label: "Net broker flow" },
  { value: "volume_vs_avg", label: "Volume vs rata-rata 20 hari" },
  { value: "price_change", label: "Perubahan harga" },
  { value: "confidence", label: "Keyakinan pola akumulasi" },
]
export const OPERATORS: ReadonlyArray<KSelectOption<AlertOperator>> = [
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "gte", label: "≥" },
  { value: "lte", label: "≤" },
]
export const SESSIONS: ReadonlyArray<KSelectOption<AlertSession>> = [
  { value: "any", label: "sesi apa pun" },
  { value: "session1", label: "Sesi 1" },
  { value: "session2", label: "Sesi 2" },
  { value: "eod", label: "akhir hari" },
]
export const CHANNELS: ReadonlyArray<KSelectOption<AlertChannel>> = [
  { value: "inapp", label: "in-app" },
  { value: "email", label: "email" },
]

function labelOf<TValue extends string>(
  list: ReadonlyArray<KSelectOption<TValue>>,
  v: TValue
): string {
  return list.find((o) => o.value === v)?.label ?? v
}

type Shared = {
  rule: AlertRule
  feedDependency?: FeedDependency
  className?: string
}

export type KAlertRuleProps = Shared &
  (
    | {
        mode: "display"
        enabled: boolean
        onEnabledChange: (enabled: boolean) => void
        onEdit?: () => void
        /** ISO datetime of the last trigger. */
        lastFired?: string
      }
    | {
        mode: "builder"
        onChange: (rule: AlertRule) => void
        onSave: () => void
        onCancel: () => void
        saving?: boolean
      }
  )

function Word({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

function Token({ children }: { children: ReactNode }) {
  return (
    <code className="num bg-elevated rounded-xs px-2 py-0.5 text-foreground">
      {children}
    </code>
  )
}

export function KAlertRule(props: KAlertRuleProps) {
  const { rule, feedDependency, className } = props
  const feedBadge = feedDependency && (
    <KBadge
      tone={feedDependency === "eod" ? "info" : "warning"}
      icon={IconDatabase}
    >
      {props.mode === "builder" ? "Bergantung pada feed " : "Feed "}
      {feedDependency.toUpperCase()}
    </KBadge>
  )
  const sentence =
    "flex flex-wrap items-center gap-2 text-[13px] leading-[18px] text-secondary-text"

  if (props.mode === "builder") {
    const set = <TKey extends keyof AlertRule>(
      key: TKey,
      value: AlertRule[TKey]
    ) => props.onChange({ ...rule, [key]: value })
    return (
      <Card className={cn(kCard, "w-full gap-3", className)}>
        <div role="group" aria-label="Aturan alert" className={sentence}>
          <Word>Ketika</Word>
          <KSelect
            label="Indikator"
            hideLabel
            size="xs"
            options={INDICATORS}
            value={rule.indicator}
            onValueChange={(v) => set("indicator", v)}
          />
          <KSelect
            label="Operator"
            hideLabel
            size="xs"
            options={OPERATORS}
            value={rule.operator}
            onValueChange={(v) => set("operator", v)}
            triggerClassName="min-w-[72px]"
          />
          <KInput
            label="Ambang"
            hideLabel
            value={rule.threshold}
            onChange={(e) => set("threshold", e.target.value)}
            placeholder="mis. 2,0"
            inputClassName="num h-8 w-[110px] px-2"
          />
          <Word>pada</Word>
          <KInput
            label="Ticker atau watchlist"
            hideLabel
            icon={IconSearch}
            value={rule.scope}
            onChange={(e) => set("scope", e.target.value)}
            placeholder="BBCA atau Watchlist Utama"
            inputClassName="h-8 w-[220px]"
          />
          <Word>selama</Word>
          <KSelect
            label="Sesi"
            hideLabel
            size="xs"
            options={SESSIONS}
            value={rule.session}
            onValueChange={(v) => set("session", v)}
          />
          <Word>→ kirim via</Word>
          <KSelect
            label="Saluran"
            hideLabel
            size="xs"
            options={CHANNELS}
            value={rule.channel}
            onValueChange={(v) => set("channel", v)}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {feedBadge}
            <span className="text-xs leading-[18px] text-muted-foreground">
              Cooldown {rule.cooldownMin} menit · tidak ada notifikasi ganda
            </span>
          </div>
          <div className="flex gap-2">
            <KButton variant="ghost" size="sm" onClick={props.onCancel}>
              Batal
            </KButton>
            <KButton size="sm" loading={props.saving} onClick={props.onSave}>
              Simpan aturan
            </KButton>
          </div>
        </div>
      </Card>
    )
  }

  const { enabled, onEnabledChange, onEdit, lastFired } = props
  return (
    <Card
      aria-disabled={!enabled || undefined}
      className={cn(kCard, "w-full gap-3", !enabled && "opacity-70", className)}
    >
      <div className={sentence}>
        <Word>Ketika</Word>
        <Token>{labelOf(INDICATORS, rule.indicator)}</Token>
        <Token>
          {labelOf(OPERATORS, rule.operator)} {rule.threshold}
        </Token>
        <Word>pada</Word>
        <Token>{rule.scope || "—"}</Token>
        <Word>selama</Word>
        <Token>{labelOf(SESSIONS, rule.session)}</Token>
        <Word>→</Word>
        <Token>{labelOf(CHANNELS, rule.channel)}</Token>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {feedBadge}
          <span className="flex flex-wrap items-center gap-2 text-xs leading-[18px] text-muted-foreground">
            <IconClock aria-hidden stroke={1.75} className="size-4" />
            <span className="num">
              {lastFired
                ? `Terakhir terpicu ${dateTime(lastFired)}`
                : "Belum pernah terpicu"}
            </span>
            <span aria-hidden>·</span>
            Cooldown {rule.cooldownMin} mnt
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={enabled}
            onCheckedChange={onEnabledChange}
            aria-label={enabled ? "Nonaktifkan aturan" : "Aktifkan aturan"}
            className={kFocus}
          />
          {onEdit && (
            <KIconButton
              icon={IconAdjustmentsHorizontal}
              size="sm"
              label="Ubah aturan"
              onClick={onEdit}
            />
          )}
        </div>
      </div>
    </Card>
  )
}
