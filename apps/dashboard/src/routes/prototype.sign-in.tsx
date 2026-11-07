// PROTOTYPE, throwaway: sign-up, sign-in, verification and the signed-out gate.
// Three layouts via ?variant=, each screen via ?screen=, Google on or off via ?stage=.
// The visitor asked for /market-live while signed out; every variant returns them there.
import { createFileRoute, useNavigate } from "@tanstack/react-router"

import { PrototypeSwitcher } from "@/prototype/prototype-switcher"
import { SCREENS, STAGES, VARIANTS } from "@/prototype/sign-in/variants"
import type { Screen, Stage } from "@/prototype/sign-in/variants"

export const Route = createFileRoute("/prototype/sign-in")({
  validateSearch: (s: Record<string, unknown>) => ({
    variant: typeof s.variant === "string" ? s.variant : "A",
    screen: (typeof s.screen === "string" ? s.screen : "signin") as Screen,
    stage: (typeof s.stage === "string" ? s.stage : "production") as Stage,
  }),
  component: SignInPrototype,
})

function SignInPrototype() {
  const { variant, screen, stage } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const current = VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0]
  const set = (
    patch: Partial<{ variant: string; screen: Screen; stage: Stage }>
  ) => void navigate({ search: (s) => ({ ...s, ...patch }), replace: true })
  return (
    <>
      <current.View
        screen={screen}
        google={stage === "production"}
        go={(s) => set({ screen: s })}
      />
      <PrototypeSwitcher
        variants={VARIANTS}
        current={current.key}
        onChange={(v) => set({ variant: v })}
        extras={[
          {
            label: "screen",
            options: SCREENS,
            current: screen,
            onChange: (s) => set({ screen: s as Screen }),
          },
          {
            label: "stage",
            options: STAGES,
            current: stage,
            onChange: (s) => set({ stage: s as Stage }),
          },
        ]}
      />
    </>
  )
}
