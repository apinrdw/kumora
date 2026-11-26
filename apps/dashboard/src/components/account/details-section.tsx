import { useHydrated } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import { Effect } from "effect"
import type { FormEvent } from "react"

import { KButton, KInput } from "@/components/k"
import { authClient } from "@/lib/auth-client"
import { ROLE_LABEL } from "@/lib/role"
import { SIGN_IN_METHOD_LABEL } from "@/lib/sign-in-method"
import type { AccountPage } from "@/server/auth/account-page"

import {
  AccountSection,
  OutcomeLine,
  useAccountAction,
  type Outcome,
} from "./account-section"

const saveName = (name: string) =>
  Effect.map(
    Effect.promise(() => authClient.updateUser({ name })),
    ({ error }): Outcome =>
      error
        ? { _tag: "Failed", message: "Couldn't save the name. Try again." }
        : { _tag: "Done", message: "Name saved." }
  )

/** Email, role and sign-in methods, read-only; the display name, editable. */
export function DetailsSection({
  page,
  canEdit,
}: {
  page: Pick<AccountPage, "email" | "name" | "role" | "signInMethods">
  canEdit: boolean
}) {
  const hydrated = useHydrated()
  const { pending, outcome, run } = useAccountAction()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = new FormData(event.currentTarget).get("name")
    clientRuntime.runFork(
      run(saveName(typeof name === "string" ? name.trim() : ""))
    )
  }
  return (
    <AccountSection title="Details">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-[13px]">
        <dt className="text-muted-foreground">Email</dt>
        <dd className="min-w-0 truncate">{page.email}</dd>
        <dt className="text-muted-foreground">Role</dt>
        <dd>{ROLE_LABEL[page.role]}</dd>
        <dt className="text-muted-foreground">Sign-in methods</dt>
        <dd>
          {page.signInMethods
            .map((method) => SIGN_IN_METHOD_LABEL[method])
            .join(", ") || "None"}
        </dd>
      </dl>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={submit}
      >
        <KInput
          label="Display name"
          name="name"
          defaultValue={page.name}
          autoComplete="name"
          required
          maxLength={100}
          disabled={!canEdit}
          className="sm:max-w-sm sm:flex-1"
        />
        {canEdit && (
          <KButton
            type="submit"
            variant="secondary"
            loading={pending}
            disabled={!hydrated}
          >
            Save name
          </KButton>
        )}
      </form>
      <OutcomeLine outcome={outcome} />
    </AccountSection>
  )
}
