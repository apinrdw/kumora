// PROTOTYPE, throwaway: floating variant switcher. Never rendered in production builds.
import { useEffect } from "react"

type Option = { key: string; name: string }

export function PrototypeSwitcher({
  variants,
  current,
  onChange,
  extras,
}: {
  variants: ReadonlyArray<Option>
  current: string
  onChange: (key: string) => void
  extras?: ReadonlyArray<{
    label: string
    options: ReadonlyArray<Option>
    current: string
    onChange: (key: string) => void
  }>
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
  return (
    <div className="fixed bottom-20 left-1/2 z-[100] flex -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-2xl bg-white px-2 py-1 text-xs font-semibold text-black shadow-2xl md:bottom-5 md:rounded-full">
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
      {extras?.map((x) => (
        <label key={x.label} className="flex items-center gap-1 pl-2">
          <span className="text-black/50">{x.label}</span>
          <select
            value={x.current}
            onChange={(e) => x.onChange(e.target.value)}
            className="rounded-full bg-black px-2 py-1 text-white"
          >
            {x.options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  )
}
