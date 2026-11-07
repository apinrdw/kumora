import { assert, describe, it } from "@effect/vitest"

import {
  type Account,
  type Action,
  type Reason,
  type Target,
  decide,
  signedOut,
} from "@/server/auth/policy"

const member: Account = {
  _tag: "Account",
  role: "member",
  verified: true,
  suspended: false,
  configAdmin: false,
  impersonating: false,
}
const admin: Account = { ...member, role: "admin" }
const configAdmin: Account = { ...admin, configAdmin: true }
const impersonated: Account = { ...member, impersonating: true }

const allow = { _tag: "Allow" } as const
const deny = (reason: Reason) => ({ _tag: "Deny", reason }) as const

describe("decide", () => {
  describe("the sign-in gate", () => {
    it.each([
      {
        name: "a signed-out visitor must sign in",
        account: signedOut,
        reason: "sign-in",
      },
      {
        name: "an unverified account must verify",
        account: { ...member, verified: false },
        reason: "verify",
      },
      {
        name: "a suspended account is suspended",
        account: { ...member, suspended: true },
        reason: "suspended",
      },
      {
        name: "suspension outranks a missing verification",
        account: { ...member, suspended: true, verified: false },
        reason: "suspended",
      },
    ] as const)("$name", ({ account, reason }) => {
      assert.deepStrictEqual(
        decide(account, "page.view", { feature: "market-live" }),
        {
          _tag: "Deny",
          reason,
        }
      )
    })
  })

  describe("pages and Market Live", () => {
    it.each([
      {
        who: "a member",
        account: member,
        feature: "market-live",
        decision: allow,
      },
      { who: "a member", account: member, feature: "account", decision: allow },
      {
        who: "a member",
        account: member,
        feature: "admin",
        decision: deny("not-found"),
      },
      {
        who: "an admin",
        account: admin,
        feature: "market-live",
        decision: allow,
      },
      { who: "an admin", account: admin, feature: "account", decision: allow },
      { who: "an admin", account: admin, feature: "admin", decision: allow },
      {
        who: "a config admin",
        account: configAdmin,
        feature: "admin",
        decision: allow,
      },
      {
        who: "an impersonated member",
        account: impersonated,
        feature: "account",
        decision: allow,
      },
      {
        who: "an impersonated member",
        account: impersonated,
        feature: "admin",
        decision: deny("not-found"),
      },
    ] as const)(
      "$who viewing a $feature page: $decision",
      ({ account, feature, decision }) => {
        assert.deepStrictEqual(
          decide(account, "page.view", { feature }),
          decision
        )
      }
    )

    it.each([
      "market-live.view-live",
      "market-live.view-recorded-day",
    ] as const)(
      "%s is allowed for every verified account that isn't suspended",
      (action) => {
        for (const account of [member, admin, configAdmin, impersonated]) {
          assert.deepStrictEqual(
            decide(account, action, { feature: "market-live" }),
            allow
          )
        }
        assert.deepStrictEqual(
          decide(signedOut, action, { feature: "market-live" }),
          deny("sign-in")
        )
        assert.deepStrictEqual(
          decide({ ...member, verified: false }, action, {
            feature: "market-live",
          }),
          deny("verify")
        )
        assert.deepStrictEqual(
          decide({ ...member, suspended: true }, action, {
            feature: "market-live",
          }),
          deny("suspended")
        )
      }
    )
  })
})

const otherMember: Target = {
  role: "member",
  configAdmin: false,
  isSelf: false,
  suspended: false,
}
const otherAdmin: Target = { ...otherMember, role: "admin" }
const otherConfigAdmin: Target = { ...otherAdmin, configAdmin: true }
const suspendedMember: Target = { ...otherMember, suspended: true }
const self: Target = { ...otherAdmin, isSelf: true }
const configSelf: Target = { ...self, configAdmin: true }

describe("decide on admin actions", () => {
  it("lets an admin list accounts and tells a member it is not found", () => {
    assert.deepStrictEqual(
      decide(admin, "admin.list-accounts", { feature: "admin" }),
      allow
    )
    assert.deepStrictEqual(
      decide(member, "admin.list-accounts", { feature: "admin" }),
      deny("not-found")
    )
  })

  it.each([
    {
      action: "admin.ban",
      target: "another member",
      resource: otherMember,
      decision: allow,
    },
    {
      action: "admin.ban",
      target: "another admin",
      resource: otherAdmin,
      decision: allow,
    },
    {
      action: "admin.ban",
      target: "a config admin",
      resource: otherConfigAdmin,
      decision: deny("forbidden"),
    },
    {
      action: "admin.ban",
      target: "themselves",
      resource: self,
      decision: deny("forbidden"),
    },
    {
      action: "admin.unban",
      target: "a suspended member",
      resource: suspendedMember,
      decision: allow,
    },
    {
      action: "admin.unban",
      target: "a config admin",
      resource: otherConfigAdmin,
      decision: allow,
    },
    {
      action: "admin.set-role",
      target: "another member",
      resource: otherMember,
      decision: allow,
    },
    {
      action: "admin.set-role",
      target: "another admin",
      resource: otherAdmin,
      decision: allow,
    },
    {
      action: "admin.set-role",
      target: "a config admin",
      resource: otherConfigAdmin,
      decision: deny("forbidden"),
    },
    {
      action: "admin.set-role",
      target: "themselves",
      resource: self,
      decision: deny("forbidden"),
    },
    {
      action: "admin.end-sessions",
      target: "another member",
      resource: otherMember,
      decision: allow,
    },
    {
      action: "admin.end-sessions",
      target: "a config admin",
      resource: otherConfigAdmin,
      decision: deny("forbidden"),
    },
    {
      action: "admin.end-sessions",
      target: "themselves",
      resource: self,
      decision: allow,
    },
    {
      action: "admin.end-sessions",
      target: "themselves as config admin",
      resource: configSelf,
      decision: allow,
    },
    {
      action: "admin.impersonate",
      target: "another member",
      resource: otherMember,
      decision: allow,
    },
    {
      action: "admin.impersonate",
      target: "a suspended member",
      resource: suspendedMember,
      decision: deny("forbidden"),
    },
    {
      action: "admin.impersonate",
      target: "another admin",
      resource: otherAdmin,
      decision: deny("forbidden"),
    },
    {
      action: "admin.impersonate",
      target: "a config admin",
      resource: otherConfigAdmin,
      decision: deny("forbidden"),
    },
    {
      action: "admin.impersonate",
      target: "themselves",
      resource: self,
      decision: deny("forbidden"),
    },
  ] as const)(
    "$action on $target by an admin: $decision",
    ({ action, resource, decision }) => {
      assert.deepStrictEqual(decide(admin, action, resource), decision)
      assert.deepStrictEqual(decide(configAdmin, action, resource), decision)
    }
  )

  it.each([
    "admin.ban",
    "admin.unban",
    "admin.set-role",
    "admin.end-sessions",
    "admin.impersonate",
  ] as const)("%s is not found for a member, impersonated or not", (action) => {
    assert.deepStrictEqual(
      decide(member, action, otherMember),
      deny("not-found")
    )
    assert.deepStrictEqual(
      decide(impersonated, action, otherMember),
      deny("not-found")
    )
  })

  it("applies the sign-in gate before the admin rules", () => {
    assert.deepStrictEqual(
      decide(signedOut, "admin.ban", otherMember),
      deny("sign-in")
    )
    assert.deepStrictEqual(
      decide({ ...admin, verified: false }, "admin.ban", otherMember),
      deny("verify")
    )
    assert.deepStrictEqual(
      decide({ ...admin, suspended: true }, "admin.ban", otherMember),
      deny("suspended")
    )
  })
})

describe("decide on own-account actions", () => {
  const ownAccount = { feature: "account" } as const

  it.each([
    { action: "own.change-password", member: allow, configAdmin: allow },
    {
      action: "own.change-email",
      member: allow,
      configAdmin: deny("forbidden"),
    },
    { action: "own.update-profile", member: allow, configAdmin: allow },
    { action: "own.end-sessions", member: allow, configAdmin: allow },
    { action: "own.delete", member: allow, configAdmin: deny("forbidden") },
  ] as const)(
    "$action",
    ({ action, member: forMember, configAdmin: forConfigAdmin }) => {
      assert.deepStrictEqual(decide(member, action, ownAccount), forMember)
      assert.deepStrictEqual(decide(admin, action, ownAccount), forMember)
      assert.deepStrictEqual(
        decide(configAdmin, action, ownAccount),
        forConfigAdmin
      )
      assert.deepStrictEqual(
        decide(impersonated, action, ownAccount),
        deny("forbidden")
      )
      assert.deepStrictEqual(
        decide(signedOut, action, ownAccount),
        deny("sign-in")
      )
      assert.deepStrictEqual(
        decide({ ...member, verified: false }, action, ownAccount),
        deny("verify")
      )
    }
  )
})

// An action or feature the policy has no rule for can still arrive at run
// time, from a string a gate failed to narrow. The casts stand in for that.
describe("deny by default", () => {
  it("denies an action with no rule, with no access", () => {
    const unlisted = "market-live.export" as Action
    assert.deepStrictEqual(
      decide(admin, unlisted, { feature: "market-live" } as never),
      deny("no-access")
    )
  })

  it("denies an action named like an object built-in, with no access", () => {
    const builtIn = "constructor" as Action
    assert.deepStrictEqual(
      decide(admin, builtIn, { feature: "market-live" } as never),
      deny("no-access")
    )
  })

  it("denies a page of a feature with no rule, with no access", () => {
    const unlisted = { feature: "screener" } as unknown as {
      feature: "market-live"
    }
    assert.deepStrictEqual(
      decide(admin, "page.view", unlisted),
      deny("no-access")
    )
  })

  it("still asks an unlisted action's account to sign in first", () => {
    const unlisted = "market-live.export" as Action
    assert.deepStrictEqual(
      decide(signedOut, unlisted, { feature: "market-live" } as never),
      deny("sign-in")
    )
  })
})
