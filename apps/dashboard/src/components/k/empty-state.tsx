import {
  IconAlertCircle,
  IconDatabase,
  IconEyeOff,
  IconPlus,
  IconRadar,
} from "@tabler/icons-react"
import type { TablerIcon } from "@tabler/icons-react"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

import { KButton } from "./button"

/** no-access is the permission-limited state; error is announced with role="alert". */
export type KEmptyKind =
  | "no-watchlist"
  | "no-result"
  | "no-access"
  | "no-data"
  | "error"

export const EMPTY = {
  "no-watchlist": {
    Icon: IconPlus,
    title: "Your watchlist is empty",
    description: "Add a stock code to start watching.",
    iconClass: "text-muted-foreground",
  },
  "no-result": {
    Icon: IconRadar,
    title: "Nothing matches the filter yet.",
    description: "Change the criteria to widen the results.",
    iconClass: "text-muted-foreground",
  },
  "no-access": {
    Icon: IconEyeOff,
    title: "Broker data is not included in your plan",
    description:
      "This feature needs a broker data licence. Other values stay available.",
    iconClass: "text-warning",
  },
  "no-data": {
    Icon: IconDatabase,
    title: "Not enough data for this period yet.",
    description: "Values are not replaced with zero. Try a longer period.",
    iconClass: "text-muted-foreground",
  },
  error: {
    Icon: IconAlertCircle,
    title: "Market data could not be loaded.",
    description: "Try again.",
    iconClass: "text-down",
  },
} as const satisfies Record<
  KEmptyKind,
  { Icon: TablerIcon; title: string; description: string; iconClass: string }
>

export type KAction = { label: string; onClick: () => void }

export type KEmptyStateProps = {
  kind?: KEmptyKind
  icon?: TablerIcon
  title?: string
  description?: string
  action?: KAction
  secondaryAction?: KAction
  /** Drop the dashed frame when embedded in a table or panel. */
  bare?: boolean
  className?: string
}

export function KEmptyState({
  kind = "no-result",
  icon,
  title,
  description,
  action,
  secondaryAction,
  bare = false,
  className,
}: KEmptyStateProps) {
  const c = EMPTY[kind]
  const Icon = icon ?? c.Icon
  return (
    <Empty
      role={kind === "error" ? "alert" : undefined}
      className={cn(
        "border-strong text-secondary-text max-w-[480px] gap-2 rounded-md border border-dashed px-6 py-10",
        kind === "error" && "border-down",
        bare && "max-w-none border-0",
        className
      )}
    >
      <EmptyHeader className="gap-2">
        <EmptyMedia className={cn("mb-1", c.iconClass)}>
          <Icon aria-hidden stroke={1.75} className="size-6" />
        </EmptyMedia>
        <EmptyTitle className="text-sm leading-[22px] font-medium tracking-normal text-foreground">
          {title ?? c.title}
        </EmptyTitle>
        <EmptyDescription className="text-secondary-text max-w-[360px] text-[13px] leading-[18px]">
          {description ?? c.description}
        </EmptyDescription>
      </EmptyHeader>
      {(action || secondaryAction) && (
        <EmptyContent className="mt-2 flex-row justify-center gap-2">
          {action && (
            <KButton variant="secondary" size="sm" onClick={action.onClick}>
              {action.label}
            </KButton>
          )}
          {secondaryAction && (
            <KButton
              variant="ghost"
              size="sm"
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </KButton>
          )}
        </EmptyContent>
      )}
    </Empty>
  )
}

/**
 * Async state shared by data surfaces (KDataTable, KChartPanel, KMetricCard).
 * `restricted` is the permission-limited state.
 */
export type KDataState =
  | { status: "ready" }
  | { status: "loading" }
  | { status: "empty"; kind?: KEmptyKind; title?: string; description?: string }
  | { status: "restricted"; title?: string; description?: string }
  | { status: "error"; message?: string; onRetry?: () => void }

/** Renders every non-ready KDataState; the caller supplies the loading skeleton. */
export function KStateBody({
  state,
  skeleton,
}: {
  state: Exclude<KDataState, { status: "ready" }>
  skeleton: ReactNode
}) {
  switch (state.status) {
    case "loading":
      return skeleton
    case "empty":
      return (
        <KEmptyState
          bare
          kind={state.kind ?? "no-data"}
          title={state.title}
          description={state.description}
        />
      )
    case "restricted":
      return (
        <KEmptyState
          bare
          kind="no-access"
          title={state.title}
          description={state.description}
        />
      )
    case "error":
      return (
        <KEmptyState
          bare
          kind="error"
          title={state.message}
          action={
            state.onRetry
              ? { label: "Try again", onClick: state.onRetry }
              : undefined
          }
        />
      )
  }
}
