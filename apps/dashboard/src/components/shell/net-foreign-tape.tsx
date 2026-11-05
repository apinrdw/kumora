import { IconActivity } from "@tabler/icons-react"
import { useLoaderData } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"

import { miliarShort } from "@/lib/format"

/** Orca's 42s marquee; the list renders twice so translateX(-50%) loops seamlessly. */
export function NetForeignTape() {
  const { netForeignTape } = useLoaderData({ from: "__root__" })
  const items = netForeignTape.map(([symbol, net]) => ({
    symbol,
    text: miliarShort(net * 1e9),
    up: net > 0,
  }))
  return (
    <div
      aria-label="Net foreign per ticker (DATA DEMO)"
      className="flex h-8 items-center overflow-hidden border-b border-border bg-sidebar"
    >
      <span className="micro z-10 inline-flex shrink-0 items-center gap-1 bg-sidebar pr-3 pl-4 text-primary">
        <IconActivity aria-hidden className="size-4" />
        Net Foreign
      </span>
      <div className="group/tape flex-1 overflow-hidden">
        <div className="num motion-safe:animate-marquee flex w-max text-xs whitespace-nowrap group-hover/tape:[animation-play-state:paused]">
          {[0, 1].map((copy) =>
            items.map((t) => (
              <span
                key={`${copy}-${t.symbol}`}
                aria-hidden={copy === 1}
                className="pr-5"
              >
                <b className="mr-1 font-[650] text-foreground">{t.symbol}</b>
                <span className={cn(t.up ? "text-up" : "text-down")}>
                  {t.text}
                </span>
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
