import { assert, describe, it } from "@effect/vitest"
import { Unauthorized } from "@workspace/server"
import { Effect } from "effect"
import { DatabaseSync } from "node:sqlite"

import { gatePage, verifyScreen } from "@/server/auth/gate"
import type { Mail } from "@/server/auth/mailer"

import { replayMigrations } from "../../../scripts/auth-schema.ts"

import {
  ADMIN_EMAIL,
  cookiesAfter,
  cookiesFrom,
  linkIn,
  post,
  seam,
  send,
  signUp,
} from "./seam.ts"

const page = {
  href: "/market-live?day=2026-11-06",
  feature: "market-live",
} as const

const headers = (cookie?: string) =>
  new Headers(cookie === undefined ? {} : { cookie })

const signedUp = Effect.fnUntraced(function* (email: string) {
  return cookiesFrom(yield* signUp(email))
})

const verified = (mails: ReadonlyArray<Mail>) =>
  Effect.fnUntraced(function* (email: string) {
    yield* signUp(email)
    return cookiesFrom(yield* send(linkIn(mails.at(-1))))
  })

describe("gatePage", () => {
  it.effect(
    "sends a visitor with no session to sign-in, keeping the path",
    () => {
      const { layer } = seam()
      return Effect.gen(function* () {
        const error = yield* Effect.flip(gatePage(headers(), page))
        assert.deepStrictEqual(
          error,
          new Unauthorized({
            redirectTo: "/sign-in?redirect=%2Fmarket-live%3Fday%3D2026-11-06",
          })
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("sends an unverified session to the verify screen", () => {
    const { layer } = seam()
    return Effect.gen(function* () {
      const cookie = yield* signedUp("ayu@example.com")
      const error = yield* Effect.flip(gatePage(headers(cookie), page))
      assert.deepStrictEqual(
        error,
        new Unauthorized({
          redirectTo: "/verify?redirect=%2Fmarket-live%3Fday%3D2026-11-06",
        })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("lets a verified account in, with the features it may view", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)("ayu@example.com")
      const access = yield* gatePage(headers(cookie), page)
      assert.deepStrictEqual(access, {
        _tag: "Allowed",
        viewer: {
          name: "Ayu",
          email: "ayu@example.com",
          features: ["market-live", "stocks", "account"],
          impersonating: false,
        },
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers not found to a member on an admin page", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)("ayu@example.com")
      const access = yield* gatePage(headers(cookie), {
        href: "/admin/users",
        feature: "admin",
      })
      assert.deepStrictEqual(access, {
        _tag: "NotFound",
        viewer: {
          name: "Ayu",
          email: "ayu@example.com",
          features: ["market-live", "stocks", "account"],
          impersonating: false,
        },
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "lets an admin in to an admin page as soon as it is verified",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        // The cookies from the link still cache the account as a member.
        const cookie = yield* verified(mails)(ADMIN_EMAIL)
        const access = yield* gatePage(headers(cookie), {
          href: "/admin/users",
          feature: "admin",
        })
        assert.deepStrictEqual(access, {
          _tag: "Allowed",
          viewer: {
            name: "Ayu",
            email: ADMIN_EMAIL,
            features: ["market-live", "stocks", "account", "admin"],
            impersonating: false,
          },
        })
      }).pipe(Effect.provide(layer))
    }
  )

  // Each statement is a round trip to AuthDb's primary, about 90 ms from
  // Singapore to apac's Tokyo (apinrdw/kumora#658).
  it.effect("reads an admin page's session in one statement", () => {
    const database = new DatabaseSync(":memory:")
    replayMigrations(database)
    const statements: Array<string> = []
    const counted = new Proxy(database, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target)
        if (key === "prepare")
          return (sql: string) => {
            statements.push(sql)
            return target.prepare(sql)
          }
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const { layer, mails } = seam(undefined, {}, { database: counted })
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL)
      statements.length = 0
      yield* gatePage(headers(cookie), {
        href: "/admin/users",
        feature: "admin",
      })
      assert.strictEqual(statements.length, 1, statements.join("\n"))
    }).pipe(Effect.provide(layer))
  })
})

describe("verifyScreen", () => {
  it.effect("sends a visitor with no session to sign-in", () => {
    const { layer } = seam()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(verifyScreen(headers(), "/market-live"))
      assert.deepStrictEqual(
        error,
        new Unauthorized({ redirectTo: "/sign-in?redirect=%2Fmarket-live" })
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows an unverified session its email", () => {
    const { layer } = seam()
    return Effect.gen(function* () {
      const cookie = yield* signedUp("ayu@example.com")
      const screen = yield* verifyScreen(headers(cookie), "/market-live")
      assert.deepStrictEqual(screen, {
        _tag: "Unverified",
        email: "ayu@example.com",
        impersonating: false,
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "shows an admin viewing as an unverified member the screen, marked as viewed by an admin",
    () => {
      const { layer, mails } = seam()
      return Effect.gen(function* () {
        const admin = yield* verified(mails)(ADMIN_EMAIL)
        const created = yield* signUp("ayu@example.com")
        const { user } = yield* Effect.promise(
          () => created.json() as Promise<{ user: { id: string } }>
        )
        const response = yield* post(
          "/admin/impersonate-user",
          { userId: user.id },
          { cookie: admin }
        )
        assert.strictEqual(response.status, 200)
        const screen = yield* verifyScreen(
          headers(cookiesAfter(admin, response)),
          "/market-live"
        )
        assert.deepStrictEqual(screen, {
          _tag: "Unverified",
          email: "ayu@example.com",
          impersonating: true,
        })
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("sends a session verified elsewhere on to the page", () => {
    const { layer, mails } = seam()
    return Effect.gen(function* () {
      // The cookies from sign-up still cache the account as unverified.
      const cookie = yield* signedUp("ayu@example.com")
      yield* send(linkIn(mails[0]))
      const error = yield* Effect.flip(
        verifyScreen(headers(cookie), "/market-live")
      )
      assert.deepStrictEqual(
        error,
        new Unauthorized({ redirectTo: "/market-live" })
      )
    }).pipe(Effect.provide(layer))
  })
})
