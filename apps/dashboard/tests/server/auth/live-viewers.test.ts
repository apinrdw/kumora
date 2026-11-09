// A ban, revoke or delete closes the account's live Market Live pages at once
// (apinrdw/kumora#144): the handler seam's after-hook tells a real trading
// day, as the Worker tells today's Durable Object.
import { assert, describe, it } from "@effect/vitest"
import { ViewerCloseCode, WibDate } from "@workspace/relay"
import { Effect, Scope } from "effect"
import type { DatabaseSync } from "node:sqlite"

import type { Mail } from "@/server/auth/mailer"
import { makeTradingDay } from "@/server/market-live/trading-day"

import {
  ADMIN_EMAIL,
  cookiesFrom,
  linkIn,
  post,
  seam,
  send,
  signUp,
} from "./seam.ts"

const PASSWORD = "correct horse"
const MEMBER = "ayu@example.com"
const OTHER = "budi@example.com"

// A Market Live page's viewer socket, as the trading day sees it.
class Page {
  closedWith: number | undefined
  constructor(
    readonly userId: string,
    readonly sessionId: string
  ) {}
  send = () => Effect.void
  close = (code: number) =>
    Effect.sync(() => {
      this.closedWith = code
    })
  state = Effect.succeed("ready" as const)
  setState = () => Effect.void
}

const json = <A>(response: Response) =>
  Effect.promise(() => response.json() as Promise<A>)

const live = Effect.fnUntraced(function* () {
  const pages: Array<Page> = []
  const day = yield* makeTradingDay({
    date: WibDate.make("2026-11-09"),
    viewers: Effect.sync(() => pages),
    viewersOf: (userId) =>
      Effect.sync(() =>
        pages
          .filter((page) => page.userId === userId)
          .map((peer) => ({ peer, sessionId: peer.sessionId }))
      ),
  }).pipe(Scope.provide(yield* Scope.make()))
  return { pages, day }
})

// Every account below verified, the member on two browsers, each browser with
// Market Live open.
const signedIn = Effect.fnUntraced(function* (
  mails: ReadonlyArray<Mail>,
  database: DatabaseSync,
  pages: Array<Page>
) {
  const browser = Effect.fnUntraced(function* (cookie: string) {
    const { session } = yield* json<{
      session: { id: string; userId: string; token: string }
    }>(yield* send("/get-session", { headers: { cookie } }))
    const page = new Page(session.userId, session.id)
    pages.push(page)
    return { cookie, page, token: session.token }
  })
  const verified = Effect.fnUntraced(function* (email: string) {
    yield* signUp(email, PASSWORD)
    return yield* browser(cookiesFrom(yield* send(linkIn(mails.at(-1)))))
  })
  const admin = yield* verified(ADMIN_EMAIL)
  const other = yield* verified(OTHER)
  const laptop = yield* verified(MEMBER)
  const phone = yield* browser(
    cookiesFrom(
      yield* post("/sign-in/email", { email: MEMBER, password: PASSWORD })
    )
  )
  const memberId = String(
    (
      database
        .prepare(`select "id" from "user" where "email" = ?`)
        .get(MEMBER) as { id: string }
    ).id
  )
  return { admin, other, laptop, phone, memberId }
})

const setup = () =>
  Effect.gen(function* () {
    const { pages, day } = yield* live()
    const { layer, mails, database } = seam(
      undefined,
      {},
      {},
      {
        endSessions: day.endSessions,
      }
    )
    return { layer, mails, database, pages }
  })

const closed = (pages: ReadonlyArray<Page>) =>
  pages.filter((page) => page.closedWith !== undefined)

describe("a live Market Live page", () => {
  it.effect.each([
    ["a ban", "/admin/ban-user"],
    ["an admin ending its sessions", "/admin/revoke-user-sessions"],
  ] as const)("is closed with 4401 on every browser by %s", ([, path]) =>
    Effect.gen(function* () {
      const { layer, mails, database, pages } = yield* setup()
      yield* Effect.gen(function* () {
        const { admin, laptop, phone, memberId } = yield* signedIn(
          mails,
          database,
          pages
        )
        const response = yield* post(
          path,
          { userId: memberId },
          { cookie: admin.cookie }
        )
        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(closed(pages), [laptop.page, phone.page])
        assert.strictEqual(
          laptop.page.closedWith,
          ViewerCloseCode.SignInRequired
        )
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("is closed on the session the account ends, and only there", () =>
    Effect.gen(function* () {
      const { layer, mails, database, pages } = yield* setup()
      yield* Effect.gen(function* () {
        const { laptop, phone } = yield* signedIn(mails, database, pages)
        const response = yield* post(
          "/revoke-session",
          { token: phone.token },
          { cookie: laptop.cookie }
        )
        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(closed(pages), [phone.page])
        assert.strictEqual(
          phone.page.closedWith,
          ViewerCloseCode.SignInRequired
        )
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("is closed on every other browser by ending the others", () =>
    Effect.gen(function* () {
      const { layer, mails, database, pages } = yield* setup()
      yield* Effect.gen(function* () {
        const { laptop, phone } = yield* signedIn(mails, database, pages)
        const response = yield* post(
          "/revoke-other-sessions",
          {},
          { cookie: laptop.cookie }
        )
        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(closed(pages), [phone.page])
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("is closed on every browser when the account is deleted", () =>
    Effect.gen(function* () {
      const { layer, mails, database, pages } = yield* setup()
      yield* Effect.gen(function* () {
        const { laptop, phone } = yield* signedIn(mails, database, pages)
        yield* post("/delete-user", {}, { cookie: laptop.cookie })
        const token =
          mails.at(-1)?.text.match(/\/delete-account\?token=(\S+)/)?.[1] ?? ""
        const response = yield* send(`/delete-user/callback?token=${token}`, {
          headers: { cookie: laptop.cookie },
        })
        assert.strictEqual(response.status, 200)
        assert.deepStrictEqual(closed(pages), [laptop.page, phone.page])
      }).pipe(Effect.provide(layer))
    })
  )

  it.effect("stays open when the ban is refused", () =>
    Effect.gen(function* () {
      const { layer, mails, database, pages } = yield* setup()
      yield* Effect.gen(function* () {
        const { other, memberId } = yield* signedIn(mails, database, pages)
        const response = yield* post(
          "/admin/ban-user",
          { userId: memberId },
          { cookie: other.cookie }
        )
        assert.strictEqual(response.status, 404)
        assert.deepStrictEqual(closed(pages), [])
      }).pipe(Effect.provide(layer))
    })
  )
})
