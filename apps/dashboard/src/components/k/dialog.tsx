import {
  IconAlertCircle,
  IconAlertTriangle,
  IconInfoCircle,
} from "@tabler/icons-react"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { cn } from "@workspace/ui/lib/utils"
import type { ElementType, ReactNode } from "react"

import { KButton } from "./button"

/** confirm: destructive, on AlertDialog · info, warning: on Dialog. */
export type KDialogKind = "confirm" | "info" | "warning"

const KIND = {
  confirm: { Icon: IconAlertTriangle, className: "text-down" },
  info: { Icon: IconInfoCircle, className: "text-info" },
  warning: { Icon: IconAlertCircle, className: "text-warning" },
} as const

export type KDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  kind?: KDialogKind
  title: string
  /** For destructive actions, name the consequence. */
  description?: string
  /** Omit for an info dialog with only a close action. */
  confirmLabel?: string
  cancelLabel?: string
  onConfirm?: () => void
  loading?: boolean
  /** Render in the page flow instead of a modal portal (showcase, docs). */
  inline?: boolean
  children?: ReactNode
}

const surface =
  "flex w-full max-w-[440px] flex-col gap-3 rounded-xl border border-border bg-popover p-6 text-sm text-foreground shadow-modal ring-0 sm:max-w-[440px] data-[size=default]:max-w-[440px] data-[size=default]:sm:max-w-[440px]"

type TextSlot = ElementType<{ className?: string; children?: ReactNode }>

function Body({
  kind,
  title,
  description,
  confirmLabel,
  cancelLabel = "Batal",
  onConfirm,
  onOpenChange,
  loading,
  children,
  Title,
  Description,
}: Omit<KDialogProps, "open" | "inline" | "kind"> & {
  kind: KDialogKind
  Title: TextSlot
  Description: TextSlot
}) {
  const k = KIND[kind]
  return (
    <>
      <div className="flex items-start gap-3">
        <k.Icon
          aria-hidden
          stroke={1.75}
          className={cn("mt-[3px] size-5 shrink-0", k.className)}
        />
        <div className="flex flex-col gap-1">
          <Title className="text-base leading-6 font-[650] text-foreground">
            {title}
          </Title>
          {description && (
            <Description className="text-secondary-text text-sm leading-[22px]">
              {description}
            </Description>
          )}
        </div>
      </div>
      {children}
      <div className="mt-2 flex justify-end gap-2">
        <KButton variant="ghost" onClick={() => onOpenChange(false)}>
          {cancelLabel}
        </KButton>
        {confirmLabel && (
          <KButton
            variant={kind === "confirm" ? "danger" : "primary"}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </KButton>
        )}
      </div>
    </>
  )
}

export function KDialog({
  open,
  kind = "info",
  inline = false,
  ...props
}: KDialogProps) {
  if (inline) {
    if (!open) return null
    return (
      <div className="bg-canvas/60 relative grid min-h-80 place-items-center rounded-lg p-6">
        <div
          role={kind === "confirm" ? "alertdialog" : "dialog"}
          aria-label={props.title}
          className={surface}
        >
          <Body {...props} kind={kind} Title="h2" Description="p" />
        </div>
      </div>
    )
  }
  if (kind === "confirm") {
    return (
      <AlertDialog open={open} onOpenChange={props.onOpenChange}>
        <AlertDialogContent className={surface}>
          <Body
            {...props}
            kind={kind}
            Title={AlertDialogTitle}
            Description={AlertDialogDescription}
          />
        </AlertDialogContent>
      </AlertDialog>
    )
  }
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent showCloseButton={false} className={surface}>
        <Body
          {...props}
          kind={kind}
          Title={DialogTitle}
          Description={DialogDescription}
        />
      </DialogContent>
    </Dialog>
  )
}
