import { assert, describe, it } from "@effect/vitest"
import { Unauthorized } from "@workspace/server"
import { Effect } from "effect"
import type { DatabaseSync } from "node:sqlite"

import type { AccountSearch } from "@/lib/account-query"
import { listAccounts } from "@/server/admin/accounts"
import type { Mail } from "@/server/auth/mailer"

import {
  ADMIN_EMAIL,
  cookiesFrom,
  linkIn,
  post,
  seam,
  send,
} from "../auth/seam.ts"

const headers = (cookie?: string) =>
  new Headers(cookie === undefined ? {} : { cookie })

const signUp = (email: string, name: string) =>
  post("/sign-up/email", {
    email,
    password: "correct horse",
    name,
    callbackURL: "/",
  })

// Signs up and opens the verification link: the account then holds two
// sessions. Returns the cookies of the second.
const verified = (mails: ReadonlyArray<Mail>) =>
  Effect.fnUntraced(function* (email: string, name: string) {
    yield* signUp(email, name)
    return cookiesFrom(yield* send(linkIn(mails.at(-1))))
  })

const emails = (page: { rows: ReadonlyArray<{ email: string }> }) =>
  page.rows.map((row) => row.email)

describe("listAccounts", () => {
  it.effect("sends a visitor with no session to sign-in", () => {
    const { layer } = seam()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(listAccounts(headers(), {}))
      assert.deepStrictEqual(
        error,
        new Unauthorized({ redirectTo: "/sign-in?redirect=%2Fadmin%2Fusers" })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers not found to a member", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)("ayu@example.com", "Ayu")
      const error = yield* Effect.flip(listAccounts(headers(cookie), {}))
      assert.strictEqual(error._tag, "NotFound")
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows an admin each account's columns", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const admin = yield* verified(mails)(ADMIN_EMAIL, "Owner")
      yield* signUp("budi@example.com", "Budi")
      const page = yield* listAccounts(headers(admin), {})
      assert.strictEqual(page.total, 2)
      const [budi, owner] = page.rows
      assert.deepInclude(budi, {
        email: "budi@example.com",
        name: "Budi",
        role: "member",
        status: "unverified",
        methods: ["password"],
        sessions: 1,
      })
      assert.deepInclude(owner, {
        email: ADMIN_EMAIL,
        name: "Owner",
        role: "admin",
        status: "active",
        sessions: 2,
      })
      assert.isNotNull(owner?.lastActiveAt)
      assert.isAtLeast(Date.parse(owner?.createdAt ?? ""), Date.now() - 60_000)
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows a banned account as suspended, with no session", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const admin = yield* verified(mails)(ADMIN_EMAIL, "Owner")
      yield* signUp("budi@example.com", "Budi")
      const { rows } = yield* listAccounts(headers(admin), {})
      yield* send("/admin/ban-user", {
        method: "POST",
        headers: { cookie: admin, "content-type": "application/json" },
        body: JSON.stringify({ userId: rows[0]?.id }),
      })
      const page = yield* listAccounts(headers(admin), { status: "suspended" })
      assert.deepStrictEqual(emails(page), ["budi@example.com"])
      assert.strictEqual(page.rows[0]?.sessions, 0)
      assert.isNull(page.rows[0]?.lastActiveAt)
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows an admin the ban's reason", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const admin = yield* verified(mails)(ADMIN_EMAIL, "Owner")
      yield* signUp("budi@example.com", "Budi")
      const { rows } = yield* listAccounts(headers(admin), {})
      yield* post(
        "/admin/ban-user",
        { userId: rows[0]?.id, banReason: "Shared the account" },
        { cookie: admin }
      )
      const page = yield* listAccounts(headers(admin), { status: "suspended" })
      assert.strictEqual(page.rows[0]?.banReason, "Shared the account")
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "says which actions the access policy allows on each account",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const admin = yield* verified(mails)(ADMIN_EMAIL, "Owner")
        yield* verified(mails)("budi@example.com", "Budi")
        const { rows } = yield* listAccounts(headers(admin), {})
        const allowed = Object.fromEntries(
          rows.map((row) => [row.email, row.allowed])
        )
        assert.deepStrictEqual(allowed, {
          [ADMIN_EMAIL]: {
            "admin.ban": false,
            "admin.unban": true,
            "admin.set-role": false,
            "admin.end-sessions": true,
            "admin.impersonate": false,
          },
          "budi@example.com": {
            "admin.ban": true,
            "admin.unban": true,
            "admin.set-role": true,
            "admin.end-sessions": true,
            "admin.impersonate": true,
          },
        })
      }).pipe(Effect.provide(layer))
    }
  )

  describe("finding accounts", () => {
    const people = [
      ["ayu@example.com", "Ayu Lestari"],
      ["budi@kantor.id", "Budi Santoso"],
      ["citra@example.com", "Citra Ayuningtyas"],
    ] as const

    const listed = (search: AccountSearch) => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const admin = yield* verified(mails)(ADMIN_EMAIL, "Owner")
        for (const [email, name] of people) yield* signUp(email, name)
        yield* send(linkIn(mails.at(-1)))
        return emails(yield* listAccounts(headers(admin), search))
      }).pipe(Effect.provide(layer))
    }

    it.effect.each([
      ["part of an email, any case", { q: "KANTOR" }, ["budi@kantor.id"]],
      [
        "part of a name",
        { q: "ayu" },
        ["citra@example.com", "ayu@example.com"],
      ],
      ["role", { role: "admin" }, [ADMIN_EMAIL]],
      [
        "status",
        { status: "unverified" },
        ["budi@kantor.id", "ayu@example.com"],
      ],
      [
        "oldest first",
        { sort: "createdAt", dir: "asc" },
        [ADMIN_EMAIL, ...people.map(([email]) => email)],
      ],
    ] as const)("by %s", ([, search, expected]) =>
      Effect.map(listed(search), (found) =>
        assert.deepStrictEqual(found, [...expected])
      )
    )

    it.effect("by last active, accounts with no session last", () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const admin = yield* verified(mails)(ADMIN_EMAIL, "Owner")
        yield* signUp("ayu@example.com", "Ayu")
        yield* signUp("budi@example.com", "Budi")
        const { rows } = yield* listAccounts(headers(admin), {})
        const budi = rows.find((row) => row.email === "budi@example.com")
        yield* send("/admin/revoke-user-sessions", {
          method: "POST",
          headers: { cookie: admin, "content-type": "application/json" },
          body: JSON.stringify({ userId: budi?.id }),
        })
        const page = yield* listAccounts(headers(admin), {
          sort: "lastActiveAt",
        })
        assert.deepStrictEqual(emails(page), [
          "ayu@example.com",
          ADMIN_EMAIL,
          "budi@example.com",
        ])
      }).pipe(Effect.provide(layer))
    })
  })

  it.effect("counts only sessions that haven't expired", () => {
    const { layer, mails, database } = seam()
    return Effect.gen(function* () {
      const admin = yield* verified(mails)(ADMIN_EMAIL, "Owner")
      insertAccounts(database, 1)
      const session = database.prepare(
        `insert into "session" ("id", "token", "userId", "expiresAt", "createdAt", "updatedAt") values (?, ?, 'seed-0', ?, ?, ?)`
      )
      const hour = 60 * 60 * 1000
      for (const [id, expires] of [
        ["live", Date.now() + hour],
        ["expired", Date.now() - hour],
      ] as const) {
        const at = new Date(expires - 2 * hour).toISOString()
        session.run(id, id, new Date(expires).toISOString(), at, at)
      }
      const { rows } = yield* listAccounts(headers(admin), { q: "seed-0" })
      assert.strictEqual(rows[0]?.sessions, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "offers impersonation of a member only, never an admin or a suspended account",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const admin = yield* verified(mails)(ADMIN_EMAIL, "Owner")
        yield* verified(mails)("other@example.com", "Other Admin")
        yield* verified(mails)("ayu@example.com", "Ayu")
        yield* verified(mails)("budi@example.com", "Budi")
        const before = yield* listAccounts(headers(admin), {})
        yield* send("/admin/ban-user", {
          method: "POST",
          headers: { cookie: admin, "content-type": "application/json" },
          body: JSON.stringify({
            userId: before.rows.find((row) => row.email === "budi@example.com")
              ?.id,
          }),
        })
        const { rows } = yield* listAccounts(headers(admin), {})
        assert.deepStrictEqual(
          Object.fromEntries(
            rows.map((row) => [row.email, row.allowed["admin.impersonate"]])
          ),
          {
            [ADMIN_EMAIL]: false,
            "other@example.com": false,
            "ayu@example.com": true,
            "budi@example.com": false,
          }
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("lists 50 accounts a page", () => {
    const { layer, mails, database } = seam()
    return Effect.gen(function* () {
      const admin = yield* verified(mails)(ADMIN_EMAIL, "Owner")
      insertAccounts(database, 60)
      const first = yield* listAccounts(headers(admin), {})
      const second = yield* listAccounts(headers(admin), { page: 2 })
      assert.strictEqual(first.total, 61)
      assert.strictEqual(first.rows.length, 50)
      assert.strictEqual(second.rows.length, 11)
      assert.notInclude(emails(second), emails(first)[49])
    }).pipe(Effect.provide(layer))
  })
})

// Accounts written straight to the database, older than any signed up.
function insertAccounts(database: DatabaseSync, count: number) {
  const insert = database.prepare(
    `insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") values (?, ?, ?, 0, ?, ?)`
  )
  for (let i = 0; i < count; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
    insert.run(`seed-${i}`, `Seed ${i}`, `seed-${i}@example.com`, at, at)
  }
}
