// PROTOTYPE, throwaway: Market Live layouts on fake relay data, switchable via ?variant=.
// I, J, K browse a past trading day (?day=YYYY-MM-DD); "Today · live" returns to F.
import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { PrototypeSwitcher } from "@/prototype/prototype-switcher"
import {
  VariantA,
  VariantB,
  VariantC,
  VariantD,
  VariantE,
  VariantF,
  VariantG,
  VariantH,
} from "@/prototype/market-live/variants"
import { VariantI, VariantJ, VariantK } from "@/prototype/market-live/past-day"

const VARIANTS = [
  { key: "A", name: "Terminal split", View: VariantA },
  { key: "B", name: "Tape-first + watchlist", View: VariantB },
  { key: "C", name: "Chart-first + palette", View: VariantC },
  { key: "D", name: "A + watchlist column", View: VariantD },
  { key: "E", name: "A + watchlist over tape", View: VariantE },
  { key: "F", name: "E + book: IDX ladder", View: VariantF },
  { key: "G", name: "E + book: vertical full depth", View: VariantG },
  { key: "H", name: "E + book: summary + depth curve", View: VariantH },
  { key: "I", name: "Past day: static close + stepper", View: VariantI },
  { key: "J", name: "Past day: replay", View: VariantJ },
  { key: "K", name: "Past day: day strip + candle cursor", View: VariantK },
] as const

export const Route = createFileRoute("/prototype/market-live")({
  validateSearch: (s: Record<string, unknown>) => ({
    variant: typeof s.variant === "string" ? s.variant : "A",
    code: typeof s.code === "string" ? s.code : "BBCA",
    day: typeof s.day === "string" ? s.day : undefined,
  }),
  component: MarketLivePrototype,
})

function MarketLivePrototype() {
  const { variant, code, day } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const current = VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0]
  const set = (
    patch: Partial<{ variant: string; code: string; day: string | undefined }>
  ) => void navigate({ search: (s) => ({ ...s, ...patch }), replace: true })
  return (
    <>
      <current.View
        code={code}
        onCode={(c) => set({ code: c })}
        day={day}
        onDay={(d) =>
          set(d === "live" ? { variant: "F", day: undefined } : { day: d })
        }
      />
      <PrototypeSwitcher
        variants={VARIANTS}
        current={current.key}
        onChange={(v) => set({ variant: v })}
      />
    </>
  )
}
