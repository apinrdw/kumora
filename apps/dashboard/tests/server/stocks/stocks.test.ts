// Who may open a stock page: every signed-in account.
import { assert, describe, it } from "@effect/vitest"
import { Unauthorized, WorkerEnv } from "@workspace/server"
import { Effect, Layer } from "effect"

import {
  brokerInventoryView,
  stockListView,
  stockPageView,
} from "@/server/stocks/stocks"

import {
  ADMIN_EMAIL,
  cookiesFrom,
  linkIn,
  post,
  seam,
  send,
} from "../auth/seam.ts"
import { memoryBrokerTotalsDb } from "../broker-totals/memory-broker-totals-db.ts"
import { memoryHoldingsDb } from "../holdings/memory-holdings-db.ts"

const headers = (cookie?: string) =>
  new Headers(cookie === undefined ? {} : { cookie })

const stocks = () => {
  const auth = seam()
  return {
    ...auth,
    layer: Layer.mergeAll(
      auth.layer,
      memoryHoldingsDb().layer,
      memoryBrokerTotalsDb().layer,
      // Market Live's clock, unshifted.
      Layer.succeed(WorkerEnv)({} as unknown as WorkerEnv["Service"])
    ),
  }
}

const signedUp = Effect.fnUntraced(function* (
  mails: ReturnType<typeof seam>["mails"],
  email: string
) {
  yield* post("/sign-up/email", {
    email,
    password: "correct horse",
    name: "Ayu",
    callbackURL: "/",
  })
  return cookiesFrom(yield* send(linkIn(mails.at(-1))))
})

describe("the stock page", () => {
  it.effect("sends a visitor with no session to sign-in", () => {
    const { layer } = stocks()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        stockPageView(headers(), "BBCA", undefined)
      )
      assert.deepStrictEqual(
        error,
        new Unauthorized({ redirectTo: "/sign-in?redirect=%2Fstocks%2FBBCA" })
      )
      assert.deepStrictEqual(
        yield* Effect.flip(
          brokerInventoryView(headers(), "BBCA", { range: "3M" })
        ),
        new Unauthorized({
          redirectTo: "/sign-in?redirect=%2Fstocks%2FBBCA%3Ftab%3Dbrokers",
        })
      )
      const list = yield* Effect.flip(stockListView(headers(), "/stocks/BBCA"))
      assert.strictEqual(list._tag, "Unauthorized")
    }).pipe(Effect.provide(layer))
  })

  it.effect.each(["ayu@example.com", ADMIN_EMAIL])("opens for %s", (email) => {
    const { layer, mails } = stocks()
    return Effect.gen(function* () {
      const cookie = yield* signedUp(mails, email)
      const page = yield* stockPageView(headers(cookie), "BBCA", undefined)
      assert.strictEqual(page.code, "BBCA")
      assert.deepStrictEqual(
        yield* stockListView(headers(cookie), "/stocks/BBCA"),
        []
      )
      const inventory = yield* brokerInventoryView(headers(cookie), "BBCA", {
        range: "3M",
      })
      assert.deepStrictEqual(inventory.days, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers not found to a code that isn't a stock code", () => {
    const { layer, mails } = stocks()
    return Effect.gen(function* () {
      const cookie = yield* signedUp(mails, "ayu@example.com")
      const error = yield* Effect.flip(
        stockPageView(headers(cookie), "bbca", undefined)
      )
      assert.strictEqual(error._tag, "NotFound")
      const inventory = yield* Effect.flip(
        brokerInventoryView(headers(cookie), "bbca", { range: "3M" })
      )
      assert.strictEqual(inventory._tag, "NotFound")
    }).pipe(Effect.provide(layer))
  })
})
