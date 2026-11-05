import { IconX } from "@tabler/icons-react"
import type { TablerIcon } from "@tabler/icons-react"
import { Toggle } from "@workspace/ui/components/toggle"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

import { kFocus } from "./styles"

const pill =
  "inline-flex h-7 items-center gap-1 rounded-full border border-strong bg-surface px-3 text-[13px] leading-[18px] font-[450] whitespace-nowrap text-secondary-text transition-colors hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
const pressed =
  "aria-pressed:border-primary aria-pressed:bg-selected aria-pressed:text-foreground data-pressed:bg-selected"

type ChipContent = {
  icon?: TablerIcon
  /** Count of matches or active filters. */
  count?: number
  disabled?: boolean
  className?: string
  children: ReactNode
}

export type KChipProps = ChipContent &
  (
    | {
        /** Dashed "Reset" chip: a plain action, not a toggle. */
        reset: true
        onClick: () => void
      }
    | {
        reset?: false
        selected?: boolean
        onSelectedChange?: (selected: boolean) => void
        /** Renders an × that removes the filter. */
        onRemove?: () => void
      }
  )

function Inner({ icon: Icon, count, children }: ChipContent) {
  return (
    <>
      {Icon && <Icon aria-hidden stroke={1.75} className="size-4" />}
      {children}
      {count !== undefined && (
        <span className="num group-aria-pressed/toggle:text-secondary-text text-[11px] text-muted-foreground">
          {count}
        </span>
      )}
    </>
  )
}

/** A filter pill on shadcn Toggle. */
export function KChip(props: KChipProps) {
  if (props.reset) {
    return (
      <button
        type="button"
        onClick={props.onClick}
        disabled={props.disabled}
        className={cn(pill, "border-dashed", kFocus, props.className)}
      >
        <Inner {...props} />
      </button>
    )
  }
  const { selected, onSelectedChange, onRemove, disabled, className } = props
  const toggle = (
    <Toggle
      pressed={selected ?? false}
      onPressedChange={onSelectedChange}
      disabled={disabled}
      className={cn(
        pill,
        pressed,
        kFocus,
        onRemove && "rounded-r-none border-r-0 pr-1",
        !onRemove && className
      )}
    >
      <Inner {...props} />
    </Toggle>
  )
  if (!onRemove) return toggle
  // The × is a sibling button: a button nested inside the toggle is invalid HTML.
  return (
    <span className={cn("inline-flex", className)}>
      {toggle}
      <button
        type="button"
        aria-label="Hapus filter"
        onClick={onRemove}
        disabled={disabled}
        className={cn(
          pill,
          "rounded-l-none border-l-0 px-2",
          selected && "bg-selected border-primary text-foreground",
          kFocus
        )}
      >
        <IconX aria-hidden stroke={1.75} className="size-4" />
      </button>
    </span>
  )
}
