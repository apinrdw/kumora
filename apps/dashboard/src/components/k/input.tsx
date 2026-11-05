import type { TablerIcon } from "@tabler/icons-react"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { cn } from "@workspace/ui/lib/utils"
import { useId } from "react"
import type { ComponentProps, ReactNode } from "react"

export type KFieldSize = "sm" | "md"

export const fieldControl =
  "w-full rounded-sm border border-strong bg-canvas text-[13px] text-foreground transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-0 disabled:opacity-50 aria-invalid:border-down aria-invalid:ring-0 dark:bg-canvas dark:disabled:bg-canvas dark:aria-invalid:border-down"

export const FIELD_HEIGHT = {
  sm: "h-9",
  md: "h-10",
} as const satisfies Record<KFieldSize, string>

type KFieldProps = {
  id: string
  /** Always set; a placeholder never replaces it. */
  label: string
  /** Visually hide the label (sentence layouts); it stays for screen readers. */
  hideLabel?: boolean
  hint?: string
  /** Error text: sets aria-invalid and the semantic-down border. */
  error?: string
  className?: string
  children: ReactNode
}

/** Label + control + hint/error stack shared by KInput and KSelect. */
export function KField({
  id,
  label,
  hideLabel,
  hint,
  error,
  className,
  children,
}: KFieldProps) {
  const message = error ?? hint
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <Label
        htmlFor={id}
        className={cn(
          "text-secondary-text text-xs leading-[18px] font-[450]",
          hideLabel && "sr-only"
        )}
      >
        {label}
      </Label>
      {children}
      {message && (
        <div
          id={`${id}-hint`}
          className={cn(
            "text-xs leading-[18px]",
            error ? "text-down" : "text-muted-foreground"
          )}
        >
          {message}
        </div>
      )}
    </div>
  )
}

export type KInputProps = Omit<ComponentProps<"input">, "size"> & {
  label: string
  hideLabel?: boolean
  hint?: string
  error?: string
  /** sm 36 · md 40 */
  size?: KFieldSize
  /** Leading icon; use IconSearch for the search variant. */
  icon?: TablerIcon
  /** Keyboard shortcut hint, e.g. "/" or "⌘K". */
  shortcut?: string
  /** Class for the outer field stack; `inputClassName` styles the input. */
  className?: string
  inputClassName?: string
}

export function KInput({
  id: givenId,
  label,
  hideLabel,
  hint,
  error,
  size = "sm",
  icon: Icon,
  shortcut,
  className,
  inputClassName,
  ...props
}: KInputProps) {
  const autoId = useId()
  const id = givenId ?? autoId
  return (
    <KField
      id={id}
      label={label}
      hideLabel={hideLabel}
      hint={hint}
      error={error}
      className={className}
    >
      <div className="relative flex items-center">
        {Icon && (
          <Icon
            aria-hidden
            stroke={1.75}
            className="pointer-events-none absolute left-3 size-4.5 text-muted-foreground"
          />
        )}
        <Input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-hint` : undefined}
          className={cn(
            fieldControl,
            FIELD_HEIGHT[size],
            "px-3 md:text-[13px]",
            Icon && "pl-9",
            shortcut && "pr-9",
            inputClassName
          )}
          {...props}
        />
        {shortcut && (
          <kbd className="num pointer-events-none absolute right-2 rounded-xs border border-border px-1 text-[11px] leading-4 text-muted-foreground">
            {shortcut}
          </kbd>
        )}
      </div>
    </KField>
  )
}
