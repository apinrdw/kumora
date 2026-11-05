import { cn } from "@workspace/ui/lib/utils"
import { Fragment } from "react"
import type { ReactNode } from "react"

import { asOf as formatAsOf } from "@/lib/format"

export type KSourceLineProps = {
  source?: string
  /** ISO datetime, rendered "per 14.45 WIB". */
  asOf?: string
  /** Extra trailing items, e.g. "Model sm-flow 0.9.2". */
  extra?: ReactNode
  className?: string
}

/** The "Feed harga · per 14.45 WIB" provenance line under every live-looking value. */
export function KSourceLine({
  source,
  asOf,
  extra,
  className,
}: KSourceLineProps) {
  const items: Array<ReactNode> = []
  if (source) items.push(<span>{source}</span>)
  if (asOf) items.push(<span className="num">per {formatAsOf(asOf)}</span>)
  if (extra) items.push(extra)
  if (!items.length) return null
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 text-xs leading-[18px] text-muted-foreground",
        className
      )}
    >
      {items.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden>·</span>}
          {item}
        </Fragment>
      ))}
    </div>
  )
}
