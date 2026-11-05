import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

import { kFocus } from "./styles"

export type KTab<TValue extends string> = {
  value: TValue
  label: string
  count?: number
}

export type KTabsProps<TValue extends string> = {
  tabs: ReadonlyArray<KTab<TValue>>
  value?: TValue
  defaultValue?: TValue
  onValueChange?: (value: TValue) => void
  /** underline: accent underline (default) · segmented: bg-selected fill, for timeframes. */
  variant?: "underline" | "segmented"
  compact?: boolean
  /** aria-label for the tablist. */
  label: string
  className?: string
  /** Optional `KTabPanel`s, rendered under the list. */
  children?: ReactNode
}

const LIST = {
  underline:
    "h-auto w-full justify-start gap-1 rounded-none border-b border-border bg-transparent p-0 group-data-horizontal/tabs:h-auto",
  segmented:
    "h-auto gap-0.5 rounded-sm border border-border bg-canvas p-0.5 group-data-horizontal/tabs:h-auto",
} as const

const TRIGGER = {
  underline:
    "flex-none rounded-none rounded-t-sm border-0 bg-transparent after:inset-x-3 after:bottom-[-1px] after:h-0.5 after:bg-primary data-active:bg-transparent data-active:after:opacity-100 dark:data-active:border-transparent dark:data-active:bg-transparent group-data-horizontal/tabs:after:inset-x-3 group-data-horizontal/tabs:after:bottom-[-1px]",
  segmented:
    "flex-none rounded-xs border-0 after:hidden data-active:bg-selected data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-selected",
} as const

export function KTabs<TValue extends string>({
  tabs,
  value,
  defaultValue,
  onValueChange,
  variant = "underline",
  compact = false,
  label,
  className,
  children,
}: KTabsProps<TValue>) {
  return (
    <Tabs
      value={value}
      defaultValue={defaultValue ?? tabs[0]?.value}
      onValueChange={(v) => {
        const picked = tabs.find((t) => t.value === v)
        if (picked) onValueChange?.(picked.value)
      }}
      className={cn("gap-3", className)}
    >
      <TabsList variant="line" aria-label={label} className={LIST[variant]}>
        {tabs.map((t) => (
          <TabsTrigger
            key={t.value}
            value={t.value}
            className={cn(
              "h-auto font-[450] text-muted-foreground hover:text-foreground dark:text-muted-foreground data-active:text-foreground",
              compact
                ? "px-2 py-1 text-xs leading-[18px]"
                : "px-3 py-2 text-[13px] leading-[18px]",
              TRIGGER[variant],
              kFocus
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="num ml-0.5 text-[11px] text-muted-foreground">
                {t.count}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  )
}

export const KTabPanel = TabsContent
