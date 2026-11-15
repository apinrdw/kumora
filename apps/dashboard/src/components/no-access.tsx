import { IconLock } from "@tabler/icons-react"

import type { Feature } from "@/server/auth/policy"

const NAME = {
  "market-live": "Market Live",
  stocks: "stock pages",
  account: "your account",
  admin: "the admin pages",
} as const satisfies Record<Feature, string>

/** What a page shows when the access policy denies its feature to this account. */
export function NoAccess({ feature }: { feature: Feature }) {
  return (
    <div className="flex flex-col gap-2 pt-16">
      <IconLock aria-hidden className="size-8 text-muted-foreground" />
      <h1 className="text-2xl font-bold">
        You don't have access to {NAME[feature]}.
      </h1>
      <p className="text-muted-foreground">Ask an admin.</p>
    </div>
  )
}
