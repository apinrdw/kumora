import { IconEye } from "@tabler/icons-react"
import { useHydrated, useRouter } from "@tanstack/react-router"
import { useState } from "react"

import { KButton } from "@/components/k"
import type { ListedAccount } from "@/lib/account-query"
import { authClient } from "@/lib/auth-client"

/** Views the dashboard as this member, behind the impersonation banner. */
export function ImpersonateButton({ row }: { row: ListedAccount }) {
  const router = useRouter()
  const hydrated = useHydrated()
  const [busy, setBusy] = useState(false)
  if (!row.allowed["admin.impersonate"]) return null
  const impersonate = async () => {
    setBusy(true)
    const { error } = await authClient.admin.impersonateUser({
      userId: row.id,
    })
    // Refused because the account changed since the list loaded: show it as
    // it is now.
    if (error) await router.invalidate()
    else await router.navigate({ to: "/" })
    setBusy(false)
  }
  return (
    <KButton
      variant="secondary"
      size="sm"
      icon={IconEye}
      disabled={!hydrated}
      loading={busy}
      onClick={() => void impersonate()}
    >
      Impersonate
    </KButton>
  )
}
