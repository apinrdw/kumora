import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"
import type { CSSProperties } from "react"

import { kCard } from "./styles"

export type KSkeletonProps =
  | { kind: "text"; width?: CSSProperties["width"]; className?: string }
  | { kind: "metric"; className?: string }
  | { kind: "table"; rows?: number; className?: string }
  | { kind: "chart"; height?: number; className?: string }

const busy = {
  role: "status",
  "aria-busy": true,
  "aria-label": "Loading…",
} as const

function Bar({
  w,
  h,
  className,
}: {
  w: CSSProperties["width"]
  h: number
  className?: string
}) {
  return (
    <Skeleton
      className={cn(
        "bg-elevated shrink-0 rounded-xs motion-reduce:animate-none",
        className
      )}
      style={{ width: w, height: h }}
    />
  )
}

/** Placeholder matching the final element's size; no false loading. */
export function KSkeleton(props: KSkeletonProps) {
  switch (props.kind) {
    case "text":
      return (
        <div {...busy} className={cn("flex flex-col gap-2", props.className)}>
          <Bar w={props.width ?? "100%"} h={14} />
          <Bar w="72%" h={14} />
        </div>
      )
    case "metric":
      return (
        <div
          {...busy}
          className={cn(
            kCard,
            "flex min-w-[220px] flex-col gap-1",
            props.className
          )}
        >
          <Bar w={96} h={14} />
          <Bar w={140} h={34} />
          <Bar w={80} h={14} />
        </div>
      )
    case "table":
      return (
        <div {...busy} className={cn("flex flex-col gap-2", props.className)}>
          {Array.from({ length: props.rows ?? 4 }, (_, i) => (
            <div
              key={i}
              className="flex h-9 items-center gap-3 overflow-hidden *:shrink"
            >
              <Bar w={72} h={14} />
              <Bar w="30%" h={12} />
              <Bar w={64} h={14} />
              <Bar w={56} h={14} />
              <Bar w={72} h={14} />
            </div>
          ))}
        </div>
      )
    case "chart":
      return (
        <div {...busy} className={cn("flex flex-col gap-2", props.className)}>
          <div className="flex items-center gap-3">
            <Bar w={140} h={18} />
            <Bar w={120} h={18} />
          </div>
          <Bar w="100%" h={props.height ?? 160} />
          <div className="flex items-center gap-3">
            <Bar w={160} h={12} />
            <Bar w={100} h={12} />
          </div>
        </div>
      )
  }
}
