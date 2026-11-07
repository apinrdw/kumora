import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import type { DatabaseSync } from "node:sqlite"

import type { Mail } from "@/server/auth/mailer"

import {
  ADMIN_EMAIL,
  cookiesFrom,
  linkIn,
  post,
  seam,
  send,
  sessionOf,
  signUp,
} from "./seam.ts"

const PASSWORD = "correct horse"
const MEMBER = "budi@example.com"
// On the seam's ADMIN_EMAILS beside ADMIN_EMAIL: a second config admin.
const OTHER_CONFIG_ADMIN = "other@example.com"
const PLAIN_ADMIN = "citra@example.com"

// Signs up and opens the verification link; the cookies of the session it opens.
const verified = (mails: ReadonlyArray<Mail>) =>
  Effect.fnUntraced(function* (email: string) {
    yield* signUp(email, PASSWORD)
    return cookiesFrom(yield* send(linkIn(mails.at(-1))))
  })

const idOf = (database: DatabaseSync, email: string) =>
  String(
    (
      database
        .prepare(`select "id" from "user" where "email" = ?`)
        .get(email) as { id: string } | undefined
    )?.id
  )

// The newest session's token: the one the account's cookies hold.
const tokenOf = (database: DatabaseSync, email: string) =>
  String(
    (
      database
        .prepare(
          `select "token" from "session" join "user" on "user"."id" = "session"."userId" where "email" = ? order by "session"."createdAt" desc`
        )
        .get(email) as { token: string } | undefined
    )?.token
  )

const signIn = (email: string) =>
  post("/sign-in/email", { email, password: PASSWORD })

const json = <A>(response: Response) =>
  Effect.promise(() => response.json() as Promise<A>)

// A config admin (owner), a second config admin, an admin promoted by the
// owner (not on the list) and a member, each verified and signed in.
const accounts = () => {
  const { layer, mails, database } = seam()
  const setup = Effect.gen(function* () {
    const owner = yield* verified(mails)(ADMIN_EMAIL)
    const other = yield* verified(mails)(OTHER_CONFIG_ADMIN)
    const plain = yield* verified(mails)(PLAIN_ADMIN)
    const member = yield* verified(mails)(MEMBER)
    const promoted = yield* post(
      "/admin/set-role",
      { userId: idOf(database, PLAIN_ADMIN), role: "admin" },
      { cookie: owner }
    )
    assert.strictEqual(promoted.status, 200)
    return {
      cookies: { owner, other, plain, member },
      id: (email: string) => idOf(database, email),
      token: (email: string) => tokenOf(database, email),
      // As if the email went on ADMIN_EMAILS after it was verified: the
      // stored role is still member.
      storeAsMember: (email: string) =>
        void database
          .prepare(`update "user" set "role" = 'member' where "email" = ?`)
          .run(email),
    }
  })
  return { layer, setup }
}

describe("admin actions on a config admin", () => {
  it.effect.each([
    ["ban", "/admin/ban-user", (id: string) => ({ userId: id })],
    [
      "demote",
      "/admin/set-role",
      (id: string) => ({ userId: id, role: "member" }),
    ],
    [
      "end the sessions",
      "/admin/revoke-user-sessions",
      (id: string) => ({ userId: id }),
    ],
  ] as const)("refuse to %s, with 403", ([, path, body]) => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies, id } = yield* setup
      for (const actor of [cookies.plain, cookies.other]) {
        const response = yield* post(path, body(id(ADMIN_EMAIL)), {
          cookie: actor,
        })
        assert.strictEqual(response.status, 403)
      }
      const session = yield* sessionOf(cookies.owner)
      assert.strictEqual(session?.user.role, "admin")
      assert.strictEqual((yield* signIn(ADMIN_EMAIL)).status, 200)
    }).pipe(Effect.provide(layer))
  })

  it.effect("refuse to end one of its sessions, with 403", () => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies, token } = yield* setup
      const response = yield* post(
        "/admin/revoke-user-session",
        { sessionToken: token(ADMIN_EMAIL) },
        { cookie: cookies.plain }
      )
      assert.strictEqual(response.status, 403)
      assert.isNotNull(yield* sessionOf(cookies.owner))
    }).pipe(Effect.provide(layer))
  })
})

describe("an email put on ADMIN_EMAILS after it was verified", () => {
  it.effect("is a config admin at once: another admin can't ban it", () => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies, id, storeAsMember } = yield* setup
      storeAsMember(OTHER_CONFIG_ADMIN)
      const response = yield* post(
        "/admin/ban-user",
        { userId: id(OTHER_CONFIG_ADMIN) },
        { cookie: cookies.plain }
      )
      assert.strictEqual(response.status, 403)
      assert.strictEqual((yield* signIn(OTHER_CONFIG_ADMIN)).status, 200)
    }).pipe(Effect.provide(layer))
  })

  it.effect("acts as an admin at once: it bans a member", () => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies, id, storeAsMember } = yield* setup
      storeAsMember(OTHER_CONFIG_ADMIN)
      const response = yield* post(
        "/admin/ban-user",
        { userId: id(MEMBER) },
        { cookie: cookies.other }
      )
      assert.strictEqual(response.status, 200)
      assert.strictEqual((yield* signIn(MEMBER)).status, 403)
    }).pipe(Effect.provide(layer))
  })

  it.effect("lists accounts at once", () => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies, storeAsMember } = yield* setup
      storeAsMember(OTHER_CONFIG_ADMIN)
      const response = yield* send("/admin/list-users", {
        headers: { cookie: cookies.other },
      })
      assert.strictEqual(response.status, 200)
    }).pipe(Effect.provide(layer))
  })

  it.effect("is stored as admin from its next sign-in", () => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { storeAsMember } = yield* setup
      storeAsMember(OTHER_CONFIG_ADMIN)
      const signedIn = cookiesFrom(yield* signIn(OTHER_CONFIG_ADMIN))
      const session = yield* sessionOf(signedIn)
      assert.strictEqual(session?.user.role, "admin")
    }).pipe(Effect.provide(layer))
  })
})

describe("an admin acting on themselves", () => {
  it.effect.each([
    ["ban", "/admin/ban-user", (id: string) => ({ userId: id })],
    [
      "demote",
      "/admin/set-role",
      (id: string) => ({ userId: id, role: "member" }),
    ],
  ] as const)("is refused to %s, with 403", ([, path, body]) => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies, id } = yield* setup
      const response = yield* post(path, body(id(PLAIN_ADMIN)), {
        cookie: cookies.plain,
      })
      assert.strictEqual(response.status, 403)
      const session = yield* sessionOf(cookies.plain)
      assert.strictEqual(session?.user.role, "admin")
    }).pipe(Effect.provide(layer))
  })

  it.effect("may end their own sessions, even as a config admin", () => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies, id } = yield* setup
      const elsewhere = cookiesFrom(yield* signIn(ADMIN_EMAIL))
      const response = yield* post(
        "/admin/revoke-user-sessions",
        { userId: id(ADMIN_EMAIL) },
        { cookie: cookies.owner }
      )
      assert.strictEqual(response.status, 200)
      assert.isNull(yield* sessionOf(elsewhere))
    }).pipe(Effect.provide(layer))
  })
})

describe("an admin acting on a member", () => {
  it.effect(
    "bans it: every session ends and sign-in answers BANNED_USER",
    () => {
      const { layer, setup } = accounts()
      return Effect.gen(function* () {
        const { cookies, id } = yield* setup
        const response = yield* post(
          "/admin/ban-user",
          { userId: id(MEMBER), banReason: "Shared the account" },
          { cookie: cookies.plain }
        )
        assert.strictEqual(response.status, 200)
        assert.isNull(yield* sessionOf(cookies.member))
        const refused = yield* signIn(MEMBER)
        assert.strictEqual(refused.status, 403)
        const body = yield* json<{ code: string; message: string }>(refused)
        assert.strictEqual(body.code, "BANNED_USER")
        assert.notInclude(body.message, "Shared the account")
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("unbans it at once, so it signs in again", () => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies, id } = yield* setup
      yield* post(
        "/admin/ban-user",
        { userId: id(MEMBER) },
        { cookie: cookies.plain }
      )
      const response = yield* post(
        "/admin/unban-user",
        { userId: id(MEMBER) },
        { cookie: cookies.plain }
      )
      assert.strictEqual(response.status, 200)
      assert.strictEqual((yield* signIn(MEMBER)).status, 200)
    }).pipe(Effect.provide(layer))
  })

  it.effect("ends one of its sessions", () => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies, token } = yield* setup
      const response = yield* post(
        "/admin/revoke-user-session",
        { sessionToken: token(MEMBER) },
        { cookie: cookies.plain }
      )
      assert.strictEqual(response.status, 200)
      assert.isNull(yield* sessionOf(cookies.member))
    }).pipe(Effect.provide(layer))
  })
})

// The admin plugin's routes that read accounts ask the policy too.
const READS = [
  [
    "list accounts",
    (_: string, cookie: string) =>
      send("/admin/list-users", { headers: { cookie } }),
  ],
  [
    "read an account",
    (id: string, cookie: string) =>
      send(`/admin/get-user?id=${id}`, { headers: { cookie } }),
  ],
  [
    "list an account's sessions",
    (id: string, cookie: string) =>
      post("/admin/list-user-sessions", { userId: id }, { cookie }),
  ],
] as const

describe("admin reads", () => {
  it.effect.each(READS)("let an admin %s", ([, read]) => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies, id } = yield* setup
      const response = yield* read(id(MEMBER), cookies.plain)
      assert.strictEqual(response.status, 200)
    }).pipe(Effect.provide(layer))
  })

  it.effect.each(READS)(
    "answer not found to a member who asks to %s",
    ([, read]) => {
      const { layer, setup } = accounts()
      return Effect.gen(function* () {
        const { cookies, id } = yield* setup
        const response = yield* read(id(PLAIN_ADMIN), cookies.member)
        assert.strictEqual(response.status, 404)
      }).pipe(Effect.provide(layer))
    }
  )
})

describe("admin plugin routes the dashboard doesn't offer", () => {
  it.effect.each([
    [
      "/admin/create-user",
      { email: "x@example.com", password: PASSWORD, name: "X" },
    ],
    ["/admin/update-user", { userId: "x", data: { name: "X" } }],
    ["/admin/remove-user", { userId: "x" }],
    ["/admin/set-user-password", { userId: "x", newPassword: PASSWORD }],
    ["/admin/has-permission", { permissions: { user: ["list"] } }],
  ] as const)("answer not found even to a config admin: %s", ([path, body]) => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies } = yield* setup
      const response = yield* post(path, body, { cookie: cookies.owner })
      assert.strictEqual(response.status, 404)
    }).pipe(Effect.provide(layer))
  })
})

describe("admin actions by anyone but an admin", () => {
  it.effect("answer not found to a member", () => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { cookies, id } = yield* setup
      const response = yield* post(
        "/admin/ban-user",
        { userId: id(PLAIN_ADMIN) },
        { cookie: cookies.member }
      )
      assert.strictEqual(response.status, 404)
    }).pipe(Effect.provide(layer))
  })

  it.effect("answer 401 to a visitor with no session", () => {
    const { layer, setup } = accounts()
    return Effect.gen(function* () {
      const { id } = yield* setup
      const response = yield* post("/admin/ban-user", { userId: id(MEMBER) })
      assert.strictEqual(response.status, 401)
    }).pipe(Effect.provide(layer))
  })
})
