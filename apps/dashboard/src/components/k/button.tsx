import { IconLoader2 } from "@tabler/icons-react"
import type { TablerIcon } from "@tabler/icons-react"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

import { KTooltip } from "./tooltip"
import { kFocus } from "./styles"

export type KButtonVariant = "primary" | "secondary" | "ghost" | "danger"
export type KButtonSize = "sm" | "md" | "lg"

const VARIANT = {
  primary: { base: "default", className: "hover:bg-accent-hover" },
  secondary: {
    base: "outline",
    className:
      "border-strong bg-surface text-foreground hover:bg-elevated dark:border-strong dark:bg-surface dark:hover:bg-elevated",
  },
  ghost: {
    base: "ghost",
    className:
      "text-secondary-text hover:bg-elevated hover:text-foreground dark:hover:bg-elevated",
  },
  // KUMORA deviation: destructive is outlined in semantic-down, not filled.
  danger: {
    base: "destructive",
    className:
      "border-down bg-transparent text-down hover:bg-elevated dark:bg-transparent dark:hover:bg-elevated",
  },
} as const satisfies Record<
  KButtonVariant,
  {
    base: NonNullable<ComponentProps<typeof Button>["variant"]>
    className: string
  }
>

const SIZE = {
  sm: "h-8 gap-2 px-2 text-xs",
  md: "h-9 gap-2 px-3 text-[13px]",
  lg: "h-10 gap-2 px-4 text-sm",
} as const satisfies Record<KButtonSize, string>

const ICON_SIZE = {
  sm: "w-8 px-0",
  md: "w-9 px-0",
  lg: "w-10 px-0",
} as const satisfies Record<KButtonSize, string>

const GLYPH = { sm: "size-4", md: "size-4.5", lg: "size-5" } as const

type ButtonBaseProps = Omit<ComponentProps<typeof Button>, "variant" | "size">

export type KButtonProps = ButtonBaseProps & {
  variant?: KButtonVariant
  /** sm 32 · md 36 · lg 40 */
  size?: KButtonSize
  /** Spinner, disabled, aria-busy. */
  loading?: boolean
  icon?: TablerIcon
}

export function KButton({
  variant = "primary",
  size = "md",
  loading = false,
  icon: Icon,
  disabled,
  className,
  children,
  ...props
}: KButtonProps) {
  const v = VARIANT[variant]
  return (
    <Button
      variant={v.base}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "rounded-sm leading-[18px] font-medium transition-colors active:not-aria-[haspopup]:translate-y-0 disabled:opacity-50",
        kFocus,
        SIZE[size],
        v.className,
        loading && "cursor-progress",
        className
      )}
      {...props}
    >
      {loading ? (
        <IconLoader2
          aria-hidden
          stroke={1.75}
          className={cn("animate-spin motion-reduce:animate-none", GLYPH[size])}
        />
      ) : Icon ? (
        <Icon aria-hidden stroke={1.75} className={GLYPH[size]} />
      ) : null}
      {children}
    </Button>
  )
}

export type KIconButtonProps = Omit<KButtonProps, "children" | "loading"> & {
  icon: TablerIcon
  /** Accessible name, also shown as the tooltip. */
  label: string
  /** Set false when the label is already visible nearby. */
  tooltip?: boolean
}

export function KIconButton({
  icon: Icon,
  label,
  variant = "ghost",
  size = "md",
  tooltip = true,
  className,
  ...props
}: KIconButtonProps) {
  const button = (
    <KButton
      variant={variant}
      size={size}
      aria-label={label}
      className={cn(ICON_SIZE[size], className)}
      {...props}
    >
      <Icon aria-hidden stroke={1.75} className={GLYPH[size]} />
    </KButton>
  )
  return tooltip ? <KTooltip content={label}>{button}</KTooltip> : button
}
