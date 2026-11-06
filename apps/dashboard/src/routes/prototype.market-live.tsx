// PROTOTYPE, throwaway: three Market Live layouts on fake relay data, switchable via ?variant=.
import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { PrototypeSwitcher } from "@/prototype/prototype-switcher"
import {
  VariantA,
  VariantB,
  VariantC,
  VariantD,
  VariantE,
} from "@/prototype/market-live/variants"

const VARIANTS = [
  { key: "A", name: "Terminal split", View: VariantA },
  { key: "B", name: "Tape-first + watchlist", View: VariantB },
  { key: "C", name: "Chart-first + palette", View: VariantC },
  { key: "D", name: "A + watchlist column", View: VariantD },
  { key: "E", name: "A + watchlist over tape", View: VariantE },
] as const

export const Route = createFileRoute("/prototype/market-live")({
  validateSearch: (s: Record<string, unknown>) => ({
    variant: typeof s.variant === "string" ? s.variant : "A",
    code: typeof s.code === "string" ? s.code : "BBCA",
  }),
  component: MarketLivePrototype,
})

function MarketLivePrototype() {
  const { variant, code } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const current = VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0]
  const set = (patch: Partial<{ variant: string; code: string }>) =>
    void navigate({ search: (s) => ({ ...s, ...patch }), replace: true })
  return (
    <>
      <current.View code={code} onCode={(c) => set({ code: c })} />
      <PrototypeSwitcher
        variants={VARIANTS}
        current={current.key}
        onChange={(v) => set({ variant: v })}
      />
    </>
  )
}
