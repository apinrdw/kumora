import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactElement, ReactNode } from "react"

import { kTooltip } from "./styles"

export type KTooltipProps = {
  /** One focusable element; it becomes the trigger. */
  children: ReactElement
  content: ReactNode
  /** Methodology note: semantic-info rule on the left and a title line. */
  explain?: boolean
  title?: string
  /** Force visible (showcase, tests). */
  open?: boolean
  side?: "top" | "bottom" | "left" | "right"
  className?: string
}

/** Never put a critical metric only inside a tooltip. */
export function KTooltip({
  children,
  content,
  explain = false,
  title,
  open,
  side = "top",
  className,
}: KTooltipProps) {
  return (
    <Tooltip open={open}>
      <TooltipTrigger render={children} />
      <TooltipContent
        side={side}
        sideOffset={8}
        className={cn(
          kTooltip,
          "block *:data-side:hidden",
          explain && "border-l-info border-l-2",
          className
        )}
      >
        <div>
          {title && (
            <span className="text-info mb-0.5 block font-medium">{title}</span>
          )}
          {content}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
