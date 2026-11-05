import {
  IconAlertTriangle,
  IconArrowDownRight,
  IconArrowUpRight,
  IconInfoCircle,
  IconMinus,
  IconRadar,
} from "@tabler/icons-react"
import type { TablerIcon } from "@tabler/icons-react"
import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

/** accent = accumulation; warning or down = distribution. */
export type KBadgeTone =
  | "neutral"
  | "info"
  | "up"
  | "down"
  | "warning"
  | "accent"

const TONE = {
  neutral: { Icon: IconMinus, className: "text-neutral" },
  info: { Icon: IconInfoCircle, className: "text-info" },
  up: { Icon: IconArrowUpRight, className: "text-up" },
  down: { Icon: IconArrowDownRight, className: "text-down" },
  warning: { Icon: IconAlertTriangle, className: "text-warning" },
  accent: { Icon: IconRadar, className: "text-primary" },
} as const satisfies Record<KBadgeTone, { Icon: TablerIcon; className: string }>

export type KBadgeProps = {
  tone?: KBadgeTone
  /** Override the tone's icon, or `false` only when the text carries the meaning alone. */
  icon?: TablerIcon | false
  /** Tabular figures. */
  numeric?: boolean
  title?: string
  className?: string
  children: ReactNode
}

export function KBadge({
  tone = "neutral",
  icon,
  numeric = false,
  title,
  className,
  children,
}: KBadgeProps) {
  const t = TONE[tone]
  const Icon = icon === false ? null : (icon ?? t.Icon)
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        "bg-elevated h-5 gap-1 rounded-xs border-border px-2 text-xs leading-[18px] font-medium",
        t.className,
        numeric && "num",
        className
      )}
    >
      {Icon && <Icon aria-hidden stroke={1.75} />}
      {children}
    </Badge>
  )
}
