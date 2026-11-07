import {
  IconBan,
  IconDotsVertical,
  IconLogout,
  IconShieldCheck,
  IconUser,
  IconUserCheck,
} from "@tabler/icons-react"
import { useHydrated } from "@tanstack/react-router"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { useState } from "react"

import type { Outcome } from "@/components/account/account-section"
import { KDialog, KInput } from "@/components/k"
import type { AccountRow } from "@/lib/account-query"
import { authClient } from "@/lib/auth-client"

/** The actions that ask first, in a dialog naming the account and the effect. */
type Confirm = "ban" | "set-role" | "end-sessions"

export type Asked = { readonly kind: Confirm; readonly row: AccountRow }

/** Runs a Better Auth admin call, then reloads the table. */
export type RunAction = (action: () => Promise<Outcome>) => Promise<void>

const outcome = (error: unknown, done: string, failed: string): Outcome =>
  error ? { _tag: "Failed", message: failed } : { _tag: "Done", message: done }

/**
 * A row's menu: only the actions the access policy allows the viewing admin
 * on this account. Unban runs at once; the rest ask first.
 */
export function AccountActions({
  row,
  onAsk,
  run,
}: {
  row: AccountRow
  onAsk: (asked: Asked) => void
  run: RunAction
}) {
  const hydrated = useHydrated()
  const suspended = row.status === "suspended"
  const items = [
    !suspended && row.allowed["admin.ban"] && (
      <DropdownMenuItem
        key="ban"
        variant="destructive"
        onClick={() => onAsk({ kind: "ban", row })}
      >
        <IconBan aria-hidden />
        Ban…
      </DropdownMenuItem>
    ),
    suspended && row.allowed["admin.unban"] && (
      <DropdownMenuItem
        key="unban"
        onClick={() =>
          void run(async () => {
            const { error } = await authClient.admin.unbanUser({
              userId: row.id,
            })
            return outcome(
              error,
              `Unbanned ${row.email}.`,
              `Couldn't unban ${row.email}. Try again.`
            )
          })
        }
      >
        <IconUserCheck aria-hidden />
        Unban
      </DropdownMenuItem>
    ),
    row.allowed["admin.set-role"] && (
      <DropdownMenuItem
        key="set-role"
        onClick={() => onAsk({ kind: "set-role", row })}
      >
        {row.role === "admin" ? (
          <IconUser aria-hidden />
        ) : (
          <IconShieldCheck aria-hidden />
        )}
        {row.role === "admin" ? "Make member…" : "Make admin…"}
      </DropdownMenuItem>
    ),
    row.allowed["admin.end-sessions"] && row.sessions > 0 && (
      <DropdownMenuItem
        key="end-sessions"
        onClick={() => onAsk({ kind: "end-sessions", row })}
      >
        <IconLogout aria-hidden />
        End sessions…
      </DropdownMenuItem>
    ),
  ].filter(Boolean)
  if (items.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${row.email}`}
        disabled={!hydrated}
        className="hover:bg-elevated grid size-7 place-items-center rounded-sm text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50"
      >
        <IconDotsVertical aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {items}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The confirmation for the action asked; closes once it has run. */
export function ConfirmAction({
  asked,
  onClose,
  run,
  pending,
}: {
  asked: Asked | null
  onClose: () => void
  run: RunAction
  pending: boolean
}) {
  const [reason, setReason] = useState("")
  const close = () => {
    setReason("")
    onClose()
  }
  if (asked === null) return null
  const { row } = asked
  const confirm = (action: () => Promise<Outcome>) => async () => {
    await run(action)
    close()
  }
  const common = {
    open: true,
    onOpenChange: (open: boolean) => {
      if (!open) close()
    },
    cancelLabel: "Cancel",
    loading: pending,
  }
  switch (asked.kind) {
    case "ban":
      return (
        <KDialog
          {...common}
          kind="confirm"
          title={`Ban ${row.email}?`}
          description="Every session of this account ends now, and it can't sign in until an admin unbans it."
          confirmLabel="Ban account"
          onConfirm={() =>
            void confirm(async () => {
              const { error } = await authClient.admin.banUser({
                userId: row.id,
                ...(reason.trim() !== "" && { banReason: reason.trim() }),
              })
              return outcome(
                error,
                `Banned ${row.email}.`,
                `Couldn't ban ${row.email}. Try again.`
              )
            })()
          }
        >
          <KInput
            label="Reason (optional)"
            hint="Only admins see it; the account never does."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
          />
        </KDialog>
      )
    case "set-role": {
      const role = row.role === "admin" ? "member" : "admin"
      return (
        <KDialog
          {...common}
          kind="warning"
          title={
            role === "admin"
              ? `Make ${row.email} an admin?`
              : `Make ${row.email} a member?`
          }
          description={
            role === "admin"
              ? "They can see every account and ban, unban, change roles and end sessions."
              : "They lose the admin pages and every admin action."
          }
          confirmLabel={role === "admin" ? "Make admin" : "Make member"}
          onConfirm={() =>
            void confirm(async () => {
              const { error } = await authClient.admin.setRole({
                userId: row.id,
                role,
              })
              return outcome(
                error,
                `${row.email} is now ${role === "admin" ? "an admin" : "a member"}.`,
                `Couldn't change the role of ${row.email}. Try again.`
              )
            })()
          }
        />
      )
    }
    case "end-sessions":
      return (
        <KDialog
          {...common}
          kind="confirm"
          title={`End every session of ${row.email}?`}
          description="Every browser signed in to this account is signed out now. It can sign in again."
          confirmLabel="End sessions"
          onConfirm={() =>
            void confirm(async () => {
              const { error } = await authClient.admin.revokeUserSessions({
                userId: row.id,
              })
              return outcome(
                error,
                `Ended every session of ${row.email}.`,
                `Couldn't end the sessions of ${row.email}. Try again.`
              )
            })()
          }
        />
      )
  }
}
