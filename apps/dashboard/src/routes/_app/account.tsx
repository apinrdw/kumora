import { createFileRoute } from "@tanstack/react-router"

import { DeleteSection } from "@/components/account/delete-section"
import { EmailSection } from "@/components/account/email-section"
import { PasswordSection } from "@/components/account/password-section"
import { ProfileSection } from "@/components/account/profile-section"
import { SessionsSection } from "@/components/account/sessions-section"
import { accountPageFn } from "@/server/auth/account-page.functions"

export const Route = createFileRoute("/_app/account")({
  staticData: { feature: "account", crumbs: () => [{ label: "Account" }] },
  // Better Auth sends a change-email link that failed back with its code.
  validateSearch: (search): { error?: string } =>
    typeof search.error === "string" ? { error: search.error } : {},
  loader: ({ location }) => accountPageFn({ data: location.href }),
  component: AccountPage,
})

// Sections in the spec's order (apinrdw/kumora#80, "/account"); change email
// and delete account follow sessions. Each takes whether the access policy
// allows its action, so the page goes read-only when it allows none.
function AccountPage() {
  const page = Route.useLoaderData()
  const { error } = Route.useSearch()
  const readOnly = !Object.values(page.allowed).some(Boolean)
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Account</h1>
        {readOnly && (
          <p className="text-[13px] text-muted-foreground">
            Read-only: this session can't change the account.
          </p>
        )}
      </header>
      <ProfileSection
        page={page}
        canEdit={page.allowed["own.update-profile"]}
      />
      {page.signInMethods.includes("password") && (
        <PasswordSection canChange={page.allowed["own.change-password"]} />
      )}
      <SessionsSection
        sessions={page.sessions}
        canEnd={page.allowed["own.end-sessions"]}
      />
      <EmailSection
        email={page.email}
        canChange={page.allowed["own.change-email"]}
        configAdmin={page.configAdmin}
        linkError={error !== undefined}
      />
      <DeleteSection
        email={page.email}
        canDelete={page.allowed["own.delete"]}
        configAdmin={page.configAdmin}
      />
    </div>
  )
}
