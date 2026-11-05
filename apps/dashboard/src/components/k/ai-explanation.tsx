import { IconChevronDown, IconRobot } from "@tabler/icons-react"
import { Card } from "@workspace/ui/components/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { cn } from "@workspace/ui/lib/utils"
import { useId } from "react"
import type { ReactNode } from "react"

import type { AIInput, Contribution } from "@/domain/signal"
import { MINUS, asOf, dateTime, plain } from "@/lib/format"
import { KBadge } from "./badge"
import { KButton } from "./button"
import { kCard } from "./styles"

export type KAIExplanationProps = {
  /** inline: collapsed behind "Why this signal?" · drawer: always expanded. */
  variant?: "inline" | "drawer"
  modelVersion?: string
  /** ISO datetime. */
  computedAt?: string
  hypothesis?: string
  inputs?: ReadonlyArray<AIInput>
  contributions?: ReadonlyArray<Contribution>
  limitations?: ReadonlyArray<string>
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

export const AI_DISCLAIMER =
  "Analisis AI adalah dukungan keputusan, bukan saran investasi individual. Skor keyakinan mengukur klasifikasi pola, bukan kemungkinan untung."

type Details = Pick<
  KAIExplanationProps,
  "inputs" | "contributions" | "limitations" | "computedAt"
>

function InputsSection({ inputs }: { inputs: ReadonlyArray<AIInput> }) {
  if (inputs.length === 0) return null
  return (
    <Section title="Sumber input (observed data)">
      {inputs.map((s) => (
        <li key={s.label}>
          {s.label}
          {s.source && (
            <span className="text-[11px] text-muted-foreground">
              {" "}
              — {s.source}
              {s.asOf && ` · ${asOf(s.asOf)}`}
            </span>
          )}
        </li>
      ))}
    </Section>
  )
}

function LimitationsSection({
  limitations,
}: {
  limitations: ReadonlyArray<string>
}) {
  if (limitations.length === 0) return null
  return (
    <Section title="Keterbatasan">
      {limitations.map((l) => (
        <li key={l}>
          <span aria-hidden className="text-warning mr-1">
            ·
          </span>
          {l}
        </li>
      ))}
    </Section>
  )
}

function ExplanationDetails({
  inputs = [],
  contributions = [],
  limitations = [],
  computedAt,
}: Details) {
  return (
    <CollapsibleContent className="flex flex-col gap-3">
      <InputsSection inputs={inputs} />
      {contributions.length > 0 && (
        <Section title="Kontribusi fitur">
          {contributions.map((c) => (
            <ContributionBar key={c.label} {...c} />
          ))}
        </Section>
      )}
      <LimitationsSection limitations={limitations} />
      <div className="border-t border-border pt-2 text-xs leading-[18px] text-muted-foreground">
        {AI_DISCLAIMER}
        {computedAt && ` Dihitung ${dateTime(computedAt)}.`}
      </div>
    </CollapsibleContent>
  )
}

function WhyTrigger() {
  return (
    <CollapsibleTrigger
      render={
        <KButton
          variant="ghost"
          size="sm"
          className="group/trigger [&_svg]:transition-transform data-panel-open:[&_svg]:rotate-180"
        />
      }
    >
      <IconChevronDown aria-hidden stroke={1.75} className="size-4" />
      Why this signal?
    </CollapsibleTrigger>
  )
}

/** Model output, always labelled AI Inference; never styled like observed data. */
export function KAIExplanation({
  variant = "inline",
  modelVersion,
  hypothesis,
  open,
  defaultOpen = false,
  onOpenChange,
  className,
  ...details
}: KAIExplanationProps) {
  const titleId = useId()
  const drawer = variant === "drawer"
  return (
    <Collapsible
      open={drawer ? true : open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      render={
        <Card
          role="region"
          aria-labelledby={titleId}
          className={cn(
            kCard,
            "w-full gap-3",
            !drawer && "bg-elevated",
            className
          )}
        />
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          id={titleId}
          className="text-info inline-flex items-center gap-2 text-[13px] leading-[18px] font-medium"
        >
          <IconRobot aria-hidden stroke={1.75} className="size-4.5" />
          AI Inference
          {modelVersion && (
            <KBadge tone="info" icon={false} numeric>
              {modelVersion}
            </KBadge>
          )}
        </span>
        {!drawer && <WhyTrigger />}
      </div>
      {hypothesis && (
        <p className="text-[13px] leading-[18px] text-foreground">
          {hypothesis}
        </p>
      )}
      <ExplanationDetails {...details} />
    </Collapsible>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="micro mb-1 text-muted-foreground">{title}</div>
      <ul className="text-secondary-text flex flex-col gap-1 text-[13px] leading-[18px]">
        {children}
      </ul>
    </div>
  )
}

/** Diverging bar around a center line: accent supports, warning weakens. */
function ContributionBar({ label, weight }: Contribution) {
  const w = Math.max(-1, Math.min(1, weight))
  const pctWidth = `${Math.abs(w) * 50}%`
  return (
    <li className="grid grid-cols-[1fr_96px_48px] items-center gap-2">
      <span>{label}</span>
      <span
        role="img"
        aria-label={`${label} ${w >= 0 ? "mendukung" : "melemahkan"} ${Math.round(Math.abs(w) * 100)}%`}
        className="bg-canvas before:bg-strong relative h-1.5 overflow-hidden rounded-xs before:absolute before:inset-y-0 before:left-1/2 before:w-px"
      >
        <i
          className={cn(
            "absolute inset-y-0",
            w >= 0 ? "left-1/2 bg-primary" : "bg-warning right-1/2"
          )}
          style={{ width: pctWidth }}
        />
      </span>
      <span className="num text-right text-xs text-foreground">
        {(w >= 0 ? "+" : MINUS) + plain(Math.abs(w), 2)}
      </span>
    </li>
  )
}
