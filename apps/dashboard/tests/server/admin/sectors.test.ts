import { assert, describe, it } from "@effect/vitest"
import { Unauthorized } from "@workspace/server"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { runSectorSyncNow, sectorTable } from "@/server/admin/sectors"
import type { Mail } from "@/server/auth/mailer"

import {
  ADMIN_EMAIL,
  cookiesFrom,
  linkIn,
  post,
  seam,
  send,
} from "../auth/seam.ts"
import { memoryHoldingsDb } from "../holdings/memory-holdings-db.ts"
import { codes, fakeIdx, profile } from "../sectors/fake-idx.ts"

const headers = (cookie?: string) =>
  new Headers(cookie === undefined ? {} : { cookie })

const verified = (mails: ReadonlyArray<Mail>) =>
  Effect.fnUntraced(function* (email: string, name: string) {
    yield* post("/sign-up/email", {
      email,
      password: "correct horse",
      name,
      callbackURL: "/",
    })
    return cookiesFrom(yield* send(linkIn(mails.at(-1))))
  })

const sectors = () => {
  const auth = seam()
  const idx = fakeIdx()
  const db = memoryHoldingsDb()
  return {
    ...auth,
    idx,
    db,
    layer: Layer.mergeAll(auth.layer, idx.layer, db.layer),
  }
}

describe("the Sectors card", () => {
  it.effect("sends a visitor with no session to sign-in", () => {
    const { layer, idx } = sectors()
    return Effect.gen(function* () {
      const redirect = new Unauthorized({
        redirectTo: "/sign-in?redirect=%2Fadmin%2Fshareholding",
      })
      assert.deepStrictEqual(
        yield* Effect.flip(sectorTable(headers())),
        redirect
      )
      assert.deepStrictEqual(
        yield* Effect.flip(runSectorSyncNow(headers())),
        redirect
      )
      assert.deepStrictEqual(idx.requests, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers not found to a member, and reads no IDX for one", () => {
    const { layer, mails, idx } = sectors()
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)("ayu@example.com", "Ayu")
      const table = yield* Effect.flip(sectorTable(headers(cookie)))
      assert.strictEqual(table._tag, "NotFound")
      const run = yield* Effect.flip(runSectorSyncNow(headers(cookie)))
      assert.strictEqual(run._tag, "NotFound")
      assert.deepStrictEqual(idx.requests, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("shows an admin an empty table, then Run now fills it", () => {
    const { layer, mails, idx } = sectors()
    idx.profiles = [profile("AADI"), profile("BBCA", "Financials")]
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      assert.deepStrictEqual(yield* sectorTable(headers(cookie)), {
        rows: 0,
        fetchedAt: null,
      })
      yield* TestClock.setTime(Date.parse("2026-11-17T03:04:05.000Z"))
      assert.deepStrictEqual(yield* runSectorSyncNow(headers(cookie)), {
        _tag: "Replaced",
        rows: 2,
      })
      assert.strictEqual(idx.requests.length, 1)
      assert.deepStrictEqual(yield* sectorTable(headers(cookie)), {
        rows: 2,
        fetchedAt: "2026-11-17T03:04:05.000Z",
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("tells an admin why a run kept the table", () => {
    const { layer, mails, idx } = sectors()
    idx.profiles = codes(10).map((code) => profile(code))
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      yield* runSectorSyncNow(headers(cookie))
      idx.profiles = codes(8).map((code) => profile(code))
      assert.deepStrictEqual(yield* runSectorSyncNow(headers(cookie)), {
        _tag: "Kept",
        reason:
          "IDX lists 8 company profiles with a stock code, under 90 % of the 10 stored",
      })
      assert.strictEqual((yield* sectorTable(headers(cookie))).rows, 10)
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers IDX's failure as a value, not a 500", () => {
    const { layer, mails, idx } = sectors()
    idx.response = () => new Response("Service unavailable", { status: 503 })
    return Effect.gen(function* () {
      const cookie = yield* verified(mails)(ADMIN_EMAIL, "Adi")
      const run = yield* runSectorSyncNow(headers(cookie))
      assert.strictEqual(run._tag, "Failed")
      assert.include(run._tag === "Failed" ? run.message : "", "answered 503")
    }).pipe(Effect.provide(layer))
  })
})
