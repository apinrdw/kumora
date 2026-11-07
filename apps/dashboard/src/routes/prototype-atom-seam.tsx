// PROTOTYPE, throwaway (apinrdw/kumora#102): five atom grains for a 500-row
// table, switchable with ?variant=A..E and the bottom bar. Branch-only.
import { RegistryContext, RegistryProvider } from "@effect/atom-react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Profiler, useContext, useEffect, useRef, useState } from "react"

import { makeRows, tick } from "@/prototype-atom-seam/model"
import type { Row } from "@/prototype-atom-seam/model"
import { VARIANTS } from "@/prototype-atom-seam/variants"
import type { VariantKey } from "@/prototype-atom-seam/variants"

const KEYS = Object.keys(VARIANTS) as VariantKey[]

export const Route = createFileRoute("/prototype-atom-seam")({
  validateSearch: (s: Record<string, unknown>): { variant: VariantKey } => ({
    variant: KEYS.includes(s.variant as VariantKey)
      ? (s.variant as VariantKey)
      : "A",
  }),
  component: Page,
})

function Page() {
  const { variant } = Route.useSearch()
  // A fresh registry per variant, so node counts don't leak across switches.
  return (
    <RegistryProvider key={variant}>
      <Bench variant={variant} />
      <Switcher current={variant} />
    </RegistryProvider>
  )
}

function Bench({ variant }: { variant: VariantKey }) {
  const { C, name } = VARIANTS[variant]
  const [rows, setRows] = useState<Row[]>(makeRows)
  const [running, setRunning] = useState<0 | 0.1 | 1>(0)
  // A ref, not state: setting state from onRender would re-render the table.
  const stats = useRef({ mount: 0, last: 0, sum: 0, n: 0 })

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setRows((r) => tick(r, running)), 250)
    return () => clearInterval(id)
  }, [running])

  return (
    <div className="flex flex-col gap-3 pb-24">
      <div className="bg-surface sticky top-0 z-10 flex flex-wrap items-center gap-3 rounded-md border border-border p-3 font-mono text-xs">
        <b className="text-foreground">
          {variant}: {name}
        </b>
        <StatsLine stats={stats} />
        {([0, 0.1, 1] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              stats.current = { ...stats.current, sum: 0, n: 0 }
              setRunning(s)
            }}
            className={`rounded border px-2 py-1 ${running === s ? "border-primary text-primary" : "border-border"}`}
          >
            {s === 0 ? "stop" : `tick ${s * 100}% / 250ms`}
          </button>
        ))}
      </div>
      <Profiler
        id={variant}
        onRender={(_, phase, ms) => {
          const st = stats.current
          st.last = ms
          if (phase === "mount") st.mount = ms
          else {
            st.sum += ms
            st.n += 1
          }
        }}
      >
        <C rows={rows} />
      </Profiler>
    </div>
  )
}

type Stats = { mount: number; last: number; sum: number; n: number }

/** Polls the stats ref and the registry, outside the profiled subtree. */
function StatsLine({ stats }: { stats: { current: Stats } }) {
  const registry = useContext(RegistryContext)
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 300)
    return () => clearInterval(id)
  }, [])
  const { mount, last, sum, n } = stats.current
  return (
    <>
      <span>mount {mount.toFixed(1)} ms</span>
      <span>last commit {last.toFixed(1)} ms</span>
      <span>
        avg update {(n ? sum / n : 0).toFixed(1)} ms ({n})
      </span>
      <span>atom nodes {registry.getNodes().size}</span>
    </>
  )
}

function Switcher({ current }: { current: VariantKey }) {
  const navigate = useNavigate({ from: "/prototype-atom-seam" })
  const i = KEYS.indexOf(current)
  const go = (d: number) =>
    navigate({
      search: { variant: KEYS[(i + d + KEYS.length) % KEYS.length] },
      replace: true,
    })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest("input, textarea, [contenteditable]")) return
      if (e.key === "ArrowLeft") go(-1)
      if (e.key === "ArrowRight") go(1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })
  if (import.meta.env.PROD) return null
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-white px-4 py-2 font-mono text-sm text-black shadow-lg">
      <button type="button" onClick={() => go(-1)}>
        ←
      </button>
      <span>
        {current} ({VARIANTS[current].name})
      </span>
      <button type="button" onClick={() => go(1)}>
        →
      </button>
    </div>
  )
}
