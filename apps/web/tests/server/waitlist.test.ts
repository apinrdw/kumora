import { assert, describe, it } from "@effect/vitest"
import { BadRequest } from "@workspace/server"
import { Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"

import { WaitlistDb, WaitlistDbError } from "@/server/waitlist/db"
import { takeQueueNumber } from "@/server/waitlist/waitlist"

import { memoryWaitlistDb } from "./memory-waitlist-db.ts"

const rowCount = (db: ReturnType<typeof memoryWaitlistDb>) =>
  (
    db.database.prepare("SELECT COUNT(*) AS n FROM waitlist").get() as {
      n: number
    }
  ).n

const join = (email: string, lang: "en" | "id" = "en") =>
  takeQueueNumber({ email, lang })

describe("takeQueueNumber", () => {
  it.effect("numbers joins in order from 1", () =>
    Effect.gen(function* () {
      const db = memoryWaitlistDb()
      const first = yield* join("ana@example.com").pipe(
        Effect.provide(db.layer)
      )
      yield* TestClock.adjust(Duration.seconds(5))
      const second = yield* join("budi@example.co.id", "id").pipe(
        Effect.provide(db.layer)
      )
      assert.deepStrictEqual(first, {
        status: "joined",
        number: 1,
        joinedAt: 0,
      })
      assert.deepStrictEqual(second, {
        status: "joined",
        number: 2,
        joinedAt: 5000,
      })
    })
  )

  it.effect(
    "gives a returning email its first number and time, burning none",
    () =>
      Effect.gen(function* () {
        const db = memoryWaitlistDb()
        yield* join("ana@example.com").pipe(Effect.provide(db.layer))
        yield* TestClock.adjust(Duration.minutes(1))
        const again = yield* join("ana@example.com", "id").pipe(
          Effect.provide(db.layer)
        )
        const next = yield* join("budi@example.com").pipe(
          Effect.provide(db.layer)
        )
        assert.deepStrictEqual(again, {
          status: "already",
          number: 1,
          joinedAt: 0,
        })
        assert.strictEqual(next.number, 2)
        assert.strictEqual(rowCount(db), 2)
      })
  )

  it.effect("never hands out a deleted row's number again", () =>
    Effect.gen(function* () {
      const db = memoryWaitlistDb()
      yield* join("ana@example.com").pipe(Effect.provide(db.layer))
      yield* join("budi@example.com").pipe(Effect.provide(db.layer))
      db.database.exec("DELETE FROM waitlist WHERE number = 2")
      const next = yield* join("citra@example.com").pipe(
        Effect.provide(db.layer)
      )
      assert.strictEqual(next.number, 3)
    })
  )

  it.effect("treats case and surrounding whitespace as the same email", () =>
    Effect.gen(function* () {
      const db = memoryWaitlistDb()
      yield* join("Ana@Example.com").pipe(Effect.provide(db.layer))
      const again = yield* join("  ana@EXAMPLE.COM\n").pipe(
        Effect.provide(db.layer)
      )
      assert.strictEqual(again.status, "already")
      assert.strictEqual(again.number, 1)
      assert.deepStrictEqual(
        db.database.prepare("SELECT email FROM waitlist").all(),
        [{ email: "ana@example.com" }]
      )
    })
  )

  it.effect("rejects a malformed or overlong email as BadRequest", () =>
    Effect.gen(function* () {
      const db = memoryWaitlistDb()
      const longest = `${"a".repeat(242)}@example.com`
      for (const email of [
        "",
        "   ",
        "ana",
        "ana@",
        "@example.com",
        "ana@example",
        "ana@@example.com",
        "ana bob@example.com",
        "ana@example..com",
        `${longest}m`,
      ]) {
        const error = yield* Effect.flip(
          join(email).pipe(Effect.provide(db.layer))
        )
        assert.deepStrictEqual(
          error,
          new BadRequest({ message: "invalid email" }),
          JSON.stringify(email)
        )
      }
      assert.strictEqual(rowCount(db), 0)
      assert.strictEqual(longest.length, 254)
      const joined = yield* join(longest).pipe(Effect.provide(db.layer))
      assert.strictEqual(joined.number, 1)
    })
  )

  it.effect("never gives two concurrent joins the same number", () =>
    Effect.gen(function* () {
      const db = memoryWaitlistDb()
      const emails = Array.from({ length: 50 }, (_, i) => `v${i}@example.com`)
      const results = yield* Effect.all(
        [...emails, ...emails].map((email) => join(email)),
        { concurrency: "unbounded" }
      ).pipe(Effect.provide(db.layer))
      const numbers = new Set(results.map(({ number }) => number))
      assert.deepStrictEqual(
        [...numbers].sort((a, b) => a - b),
        Array.from({ length: 50 }, (_, i) => i + 1)
      )
      assert.strictEqual(
        results.filter(({ status }) => status === "joined").length,
        50
      )
      emails.forEach((email, i) =>
        assert.strictEqual(results[i].number, results[i + 50].number, email)
      )
      assert.strictEqual(rowCount(db), 50)
    })
  )

  it.effect("fails with WaitlistDbError when D1 does", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        join("ana@example.com").pipe(
          Effect.provide(
            Layer.succeed(
              WaitlistDb,
              WaitlistDb.of({
                batch: () =>
                  Effect.fail(
                    new WaitlistDbError({ cause: new Error("D1 is down") })
                  ),
              })
            )
          )
        )
      )
      assert.strictEqual(error._tag, "WaitlistDbError")
    })
  )
})
