export type Role = "admin" | "member"

export type Account = {
  readonly _tag: "Account"
  readonly role: Role
  readonly verified: boolean
  readonly suspended: boolean
  readonly configAdmin: boolean
  readonly impersonating: boolean
}

export type SignedOut = { readonly _tag: "SignedOut" }

export const signedOut: SignedOut = { _tag: "SignedOut" }

type Feature = "market-live" | "account" | "admin"

type Resources = {
  readonly "page.view": { readonly feature: Feature }
  readonly "market-live.view-live": { readonly feature: "market-live" }
  readonly "market-live.view-recorded-day": { readonly feature: "market-live" }
}

export type Action = keyof Resources

export type Reason = "sign-in" | "verify" | "suspended" | "not-found"

export type Decision =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny"; readonly reason: Reason }

const allow: Decision = { _tag: "Allow" }
const deny = (reason: Reason): Decision => ({ _tag: "Deny", reason })

const featureAccess = (account: Account, feature: Feature): Decision => {
  switch (feature) {
    case "market-live":
    case "account":
      return allow
    case "admin":
      return account.role === "admin" ? allow : deny("not-found")
  }
}

type Rules = {
  readonly [A in Action]: (account: Account, resource: Resources[A]) => Decision
}

const rules: Rules = {
  "page.view": (account, { feature }) => featureAccess(account, feature),
  "market-live.view-live": (account, { feature }) =>
    featureAccess(account, feature),
  "market-live.view-recorded-day": (account, { feature }) =>
    featureAccess(account, feature),
}

export const decide = <A extends Action>(
  account: Account | SignedOut,
  action: A,
  resource: Resources[A]
): Decision => {
  if (account._tag === "SignedOut") return deny("sign-in")
  if (account.suspended) return deny("suspended")
  if (!account.verified) return deny("verify")
  return rules[action](account, resource)
}
