import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { toast } from "sonner"

import { KButton, KIconButton } from "./button"
import type { KAction } from "./empty-state"

export type KToastTone = "success" | "info" | "warning" | "error"

const TONE = {
  success: { Icon: IconCircleCheck, className: "text-up", role: "status" },
  info: { Icon: IconInfoCircle, className: "text-info", role: "status" },
  warning: {
    Icon: IconAlertTriangle,
    className: "text-warning",
    role: "alert",
  },
  error: { Icon: IconAlertCircle, className: "text-down", role: "alert" },
} as const

export type KToastProps = {
  tone: KToastTone
  title: string
  description?: string
  action?: KAction
  onDismiss?: () => void
  className?: string
}

/** The toast surface. Use `kToast.*` to show one; render directly only in docs. */
export function KToast({
  tone,
  title,
  description,
  action,
  onDismiss,
  className,
}: KToastProps) {
  const t = TONE[tone]
  return (
    <div
      role={t.role}
      className={cn(
        "bg-elevated flex w-[360px] max-w-full items-start gap-3 rounded-md border border-border px-4 py-3 shadow-popover",
        className
      )}
    >
      <t.Icon
        aria-hidden
        stroke={1.75}
        className={cn("mt-0.5 size-4.5 shrink-0", t.className)}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-[18px] font-medium text-foreground">
          {title}
        </div>
        {description && (
          <div className="text-secondary-text mt-0.5 text-xs leading-[18px]">
            {description}
          </div>
        )}
      </div>
      {action && (
        <KButton variant="ghost" size="sm" onClick={action.onClick}>
          {action.label}
        </KButton>
      )}
      {onDismiss && (
        <KIconButton
          icon={IconX}
          label="Tutup"
          size="sm"
          tooltip={false}
          onClick={onDismiss}
          className="-mt-1 -mr-1.5"
        />
      )}
    </div>
  )
}

type ToastOptions = {
  description?: string
  action?: KAction
  /** ms; errors and warnings stay longer by default. */
  duration?: number
}

const show = (tone: KToastTone, title: string, opts: ToastOptions = {}) =>
  Effect.sync(() =>
    toast.custom(
      (id) => (
        <KToast
          tone={tone}
          title={title}
          description={opts.description}
          action={
            opts.action && {
              label: opts.action.label,
              onClick: () => {
                opts.action?.onClick()
                toast.dismiss(id)
              },
            }
          }
          onDismiss={() => toast.dismiss(id)}
        />
      ),
      {
        duration:
          opts.duration ??
          (tone === "error" || tone === "warning" ? 8000 : 4000),
      }
    )
  )

/**
 * Toast helpers over sonner. Important notices also belong in the
 * notification center; a toast is transient.
 */
export const kToast = {
  success: (title: string, opts?: ToastOptions) => show("success", title, opts),
  info: (title: string, opts?: ToastOptions) => show("info", title, opts),
  warning: (title: string, opts?: ToastOptions) => show("warning", title, opts),
  error: (title: string, opts?: ToastOptions) => show("error", title, opts),
  dismiss: (id?: string | number) => Effect.sync(() => toast.dismiss(id)),
}
