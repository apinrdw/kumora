// PROTOTYPE, throwaway: floating variant switcher. Never rendered in production builds.
import { useEffect } from "react"

import { FEED } from "./market-live/fake-feed"
import type { FeedName } from "./market-live/fake-feed"

export function PrototypeSwitcher({
  variants,
  current,
  onChange,
}: {
  variants: ReadonlyArray<{ key: string; name: string }>
  current: string
  onChange: (key: string) => void
}) {
  const i = Math.max(
    0,
    variants.findIndex((v) => v.key === current)
  )
  const go = (d: number) =>
    onChange(variants[(i + d + variants.length) % variants.length]!.key)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,[contenteditable]"))
        return
      if (e.key === "ArrowLeft") go(-1)
      if (e.key === "ArrowRight") go(1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  if (import.meta.env.PROD) return null
  const drop = (f: FeedName) => (
    <button
      type="button"
      onClick={() => FEED.toggle(f)}
      className="rounded-full px-2 py-1 hover:bg-white/15"
    >
      putus/sambung {f}
    </button>
  )
  return (
    <div className="fixed bottom-20 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-white px-2 py-1 text-xs font-semibold text-black shadow-2xl md:bottom-5">
      <button
        type="button"
        onClick={() => go(-1)}
        className="rounded-full px-2 py-1 hover:bg-black/10"
      >
        ←
      </button>
      <span className="px-2">
        {variants[i]!.key} ({variants[i]!.name})
      </span>
      <button
        type="button"
        onClick={() => go(1)}
        className="rounded-full px-2 py-1 hover:bg-black/10"
      >
        →
      </button>
      <span className="mx-1 h-4 w-px bg-black/20" />
      <span className="flex rounded-full bg-black text-white">
        {drop("stockbit")}
        {drop("ajaib")}
      </span>
    </div>
  )
}
