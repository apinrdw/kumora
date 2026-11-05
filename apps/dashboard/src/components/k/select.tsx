import { IconChevronDown } from "@tabler/icons-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { cn } from "@workspace/ui/lib/utils"
import { useId } from "react"

import { KField, fieldControl } from "./input"
import type { KFieldSize } from "./input"
import { kFocus } from "./styles"

// The primitive sizes via data-[size=default]:h-8, so heights must use the same variant to win.
const TRIGGER_SIZE = {
  xs: "px-2 data-[size=default]:h-8",
  sm: "px-3 data-[size=default]:h-9",
  md: "px-3 data-[size=default]:h-10",
} as const satisfies Record<KFieldSize | "xs", string>

export type KSelectOption<TValue extends string> = {
  value: TValue
  label: string
}

export type KSelectProps<TValue extends string> = {
  label: string
  hideLabel?: boolean
  options: ReadonlyArray<KSelectOption<TValue>>
  value?: TValue
  defaultValue?: TValue
  onValueChange?: (value: TValue) => void
  placeholder?: string
  hint?: string
  error?: string
  disabled?: boolean
  /** sm 36 · md 40; `xs` 32 is for sentence layouts. */
  size?: KFieldSize | "xs"
  className?: string
  triggerClassName?: string
}

export function KSelect<TValue extends string>({
  label,
  hideLabel,
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Pilih…",
  hint,
  error,
  disabled,
  size = "sm",
  className,
  triggerClassName,
}: KSelectProps<TValue>) {
  const id = useId()
  return (
    <KField
      id={id}
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      className={className}
    >
      <Select
        items={options}
        value={value}
        defaultValue={defaultValue}
        disabled={disabled}
        onValueChange={(v) => {
          const picked = options.find((o) => o.value === v)
          if (picked) onValueChange?.(picked.value)
        }}
      >
        <SelectTrigger
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-hint` : undefined}
          className={cn(
            fieldControl,
            kFocus,
            TRIGGER_SIZE[size],
            // Swap the primitive's trailing selector icon for KUMORA's chevron.
            "[&>svg:last-child]:hidden",
            "flex items-center gap-2 py-0 data-placeholder:text-muted-foreground",
            triggerClassName
          )}
        >
          <SelectValue placeholder={placeholder} />
          <IconChevronDown
            aria-hidden
            stroke={1.75}
            className="size-4 shrink-0 text-muted-foreground"
          />
        </SelectTrigger>
        <SelectContent
          alignItemWithTrigger={false}
          className="**:data-[slot$=-item]:data-highlighted:bg-selected rounded-sm border border-border bg-popover ring-0 shadow-popover before:hidden"
        >
          {options.map((o) => (
            <SelectItem
              key={o.value}
              value={o.value}
              className="focus:bg-selected rounded-xs text-[13px]"
            >
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </KField>
  )
}
