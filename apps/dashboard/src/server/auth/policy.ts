// Decision: one attribute-based policy we own decides access, deny by default
// (apps/dashboard/docs/adr/0040-access-is-one-attribute-based-policy-we-own.md)
import { Effect } from "effect"

export const ROLES = ["admin", "member"] as const

export type Role = (typeof ROLES)[number]

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

export const FEATURES = ["market-live", "stocks", "account", "admin"] as const

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
  readonly "stocks.view": { readonly feature: "stocks" }
  readonly "admin.list-accounts": { readonly feature: "admin" }
  readonly "admin.view-shareholding-archive": { readonly feature: "admin" }
  readonly "admin.run-shareholding-archive": { readonly feature: "admin" }
  readonly "admin.run-shareholding-parse": { readonly feature: "admin" }
  readonly "admin.view-ksei-archive": { readonly feature: "admin" }
  readonly "admin.run-ksei-archive": { readonly feature: "admin" }
  readonly "admin.deep-backfill-ksei-archive": { readonly feature: "admin" }
  readonly "admin.run-ksei-parse": { readonly feature: "admin" }
  readonly "admin.view-disclosure-archive": { readonly feature: "admin" }
  readonly "admin.run-disclosure-archive": { readonly feature: "admin" }
  readonly "admin.run-sector-sync": { readonly feature: "admin" }
  readonly "admin.read-order-numbers": { readonly feature: "admin" }
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

const allow: Effect.Effect<Decision> = Effect.succeed({ _tag: "Allow" })
const deny = (reason: Reason): Effect.Effect<Decision> =>
  Effect.succeed({ _tag: "Deny", reason })

const featureAccess = (
  account: Account,
  feature: Feature
): Effect.Effect<Decision> => {
  switch (feature) {
    case "market-live":
    case "stocks":
    case "account":
      return allow
    // An impersonation session views as a member, whatever role the member
    // gains meanwhile; only the admin's own session has admin power.
    case "admin":
      return account.role === "admin" && !account.impersonating
        ? allow
        : deny("not-found")
    default:
      return deny("no-access")
  }
}

// `protectedTarget`: the action may not touch this target.
const adminOn = Effect.fnUntraced(function* (
  account: Account,
  protectedTarget: boolean
): Effect.fn.Return<Decision> {
  const access = yield* featureAccess(account, "admin")
  if (access._tag === "Deny") return access
  return yield* protectedTarget ? deny("forbidden") : allow
})

const own = Effect.fnUntraced(function* (
  account: Account,
  { feature }: OwnAccount,
  { refusedToConfigAdmin }: { readonly refusedToConfigAdmin: boolean }
): Effect.fn.Return<Decision> {
  const access = yield* featureAccess(account, feature)
  if (access._tag === "Deny") return access
  if (account.impersonating) return yield* deny("forbidden")
  return yield* refusedToConfigAdmin && account.configAdmin
    ? deny("forbidden")
    : allow
})

type Rules = {
  readonly [A in Action]: (
    account: Account,
    resource: Resources[A]
  ) => Effect.Effect<Decision>
}

const rules: Rules = {
  "page.view": (account, { feature }) => featureAccess(account, feature),
  "market-live.view-live": (account, { feature }) =>
    featureAccess(account, feature),
  "market-live.view-recorded-day": (account, { feature }) =>
    featureAccess(account, feature),
  "stocks.view": (account, { feature }) => featureAccess(account, feature),
  "admin.list-accounts": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.view-shareholding-archive": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.view-ksei-archive": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.run-ksei-archive": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.deep-backfill-ksei-archive": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.run-ksei-parse": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.view-disclosure-archive": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.run-disclosure-archive": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.run-shareholding-archive": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.run-shareholding-parse": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.run-sector-sync": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.read-order-numbers": (account, { feature }) =>
    featureAccess(account, feature),
  "admin.ban": (account, target) =>
    adminOn(account, target.configAdmin || target.isSelf),
  "admin.unban": (account) => adminOn(account, false),
  // Both targets are admins, so any role change on them is a demotion.
  "admin.set-role": (account, target) =>
    adminOn(account, target.configAdmin || target.isSelf),
  // A config admin may still end their own sessions; only other admins may not.
  "admin.end-sessions": (account, target) =>
    adminOn(account, target.configAdmin && !target.isSelf),
  "admin.impersonate": (account, target) =>
    adminOn(account, target.role !== "member" || target.suspended),
  "own.change-password": (account, resource) =>
    own(account, resource, { refusedToConfigAdmin: false }),
  "own.change-email": (account, resource) =>
    own(account, resource, { refusedToConfigAdmin: true }),
  "own.update-details": (account, resource) =>
    own(account, resource, { refusedToConfigAdmin: false }),
  "own.end-sessions": (account, resource) =>
    own(account, resource, { refusedToConfigAdmin: false }),
  "own.delete": (account, resource) =>
    own(account, resource, { refusedToConfigAdmin: true }),
}

export const decide = <A extends Action>(
  account: Account | SignedOut,
  action: A,
  resource: Resources[A]
): Effect.Effect<Decision> => {
  if (account._tag === "SignedOut") return deny("sign-in")
  if (account.suspended) return deny("suspended")
  if (!account.verified) return deny("verify")
  if (!Object.hasOwn(rules, action)) return deny("no-access")
  return rules[action](account, resource)
}
