import { assert, describe, it } from "@effect/vitest"

import {
  type Account,
  type Reason,
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
