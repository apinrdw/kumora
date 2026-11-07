// Decision: access is decided by one attribute-based policy we own, with deny
// by default. Better Auth's access control is role-based and fixed in code, so
// its admin and member roles stay underneath and the role is one attribute
// here. Every gate (pages, server functions, Better Auth hooks, the Market Live
// socket, recorded day loads) asks `decide` and maps the reason to its own
// response; feature access per account later adds an attribute and a rule, not
// gate edits. See apinrdw/kumora#95.

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

export const FEATURES = ["market-live", "account", "admin"] as const

export type Feature = (typeof FEATURES)[number]

/** The account an admin action acts on, as seen from the acting admin. */
export type Target = {
  readonly role: Role
  readonly configAdmin: boolean
  readonly isSelf: boolean
  readonly suspended: boolean
}

type OwnAccount = { readonly feature: "account" }

type Resources = {
  readonly "page.view": { readonly feature: Feature }
  readonly "market-live.view-live": { readonly feature: "market-live" }
  readonly "market-live.view-recorded-day": { readonly feature: "market-live" }
  readonly "admin.list-accounts": { readonly feature: "admin" }
  readonly "admin.ban": Target
  readonly "admin.unban": Target
  readonly "admin.set-role": Target
  readonly "admin.end-sessions": Target
  readonly "admin.impersonate": Target
  readonly "own.change-password": OwnAccount
  readonly "own.change-email": OwnAccount
  readonly "own.update-details": OwnAccount
  readonly "own.end-sessions": OwnAccount
  readonly "own.delete": OwnAccount
}

export type Action = keyof Resources

/** What an admin does to an account, on `/admin/users`. */
export type TargetAction = {
  readonly [A in Action]: Resources[A] extends Target ? A : never
}[Action]

/** What an account does to itself, on `/account`. */
export type OwnAction = Extract<Action, `own.${string}`>

export const OWN_ACCOUNT = { feature: "account" } as const satisfies OwnAccount

export type Reason =
  | "sign-in"
  | "verify"
  | "suspended"
  | "not-found"
  | "no-access"
  | "forbidden"

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
    default:
      return deny("no-access")
  }
}

const adminOn =
  (protectedTarget: (target: Target) => boolean) =>
  (account: Account, target: Target): Decision => {
    const access = featureAccess(account, "admin")
    if (access._tag === "Deny") return access
    return protectedTarget(target) ? deny("forbidden") : allow
  }

const own =
  ({ refusedToConfigAdmin }: { readonly refusedToConfigAdmin: boolean }) =>
  (account: Account, { feature }: OwnAccount): Decision => {
    const access = featureAccess(account, feature)
    if (access._tag === "Deny") return access
    if (account.impersonating) return deny("forbidden")
    return refusedToConfigAdmin && account.configAdmin
      ? deny("forbidden")
      : allow
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
  "admin.list-accounts": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.ban": adminOn((target) => target.configAdmin || target.isSelf),
  "admin.unban": adminOn(() => false),
  // Both targets are admins, so any role change on them is a demotion.
  "admin.set-role": adminOn((target) => target.configAdmin || target.isSelf),
  // A config admin may still end their own sessions; only other admins may not.
  "admin.end-sessions": adminOn(
    (target) => target.configAdmin && !target.isSelf
  ),
  "admin.impersonate": adminOn(
    (target) => target.role !== "member" || target.suspended
  ),
  "own.change-password": own({ refusedToConfigAdmin: false }),
  "own.change-email": own({ refusedToConfigAdmin: true }),
  "own.update-details": own({ refusedToConfigAdmin: false }),
  "own.end-sessions": own({ refusedToConfigAdmin: false }),
  "own.delete": own({ refusedToConfigAdmin: true }),
}

export const decide = <A extends Action>(
  account: Account | SignedOut,
  action: A,
  resource: Resources[A]
): Decision => {
  if (account._tag === "SignedOut") return deny("sign-in")
  if (account.suspended) return deny("suspended")
  if (!account.verified) return deny("verify")
  if (!Object.hasOwn(rules, action)) return deny("no-access")
  return rules[action](account, resource)
}
