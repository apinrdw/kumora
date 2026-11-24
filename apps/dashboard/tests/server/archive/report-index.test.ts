import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import type { ListedObject } from "@/server/archive/bucket"
import { MAX_LISTED_OBJECTS } from "@/server/archive/bucket"
import { recordKey, reportKey } from "@/server/ksei/keys"
import { kseiIndex } from "@/server/ksei/report-index"

import { memoryArchiveDb } from "./memory-archive-db.ts"

const FETCHED_AT = "2026-11-14T03:00:00.000Z"

// The `n`th of a listing's files and its record, each kind's period ends a
// day apart.
const report = Effect.fnUntraced(function* (n: number) {
  const kind = n % 2 === 0 ? "securities-statistics" : "securities-holdings"
  const periodEnd = new Date(Date.UTC(2000, 0, 1 + Math.floor(n / 2)))
    .toISOString()
    .slice(0, 10)
  const sha256 = n.toString(16).padStart(64, "0")
  const object = (key: string, size: number): ListedObject => ({
    key,
    size,
    uploaded: new Date(FETCHED_AT),
    customMetadata: {},
  })
  return [
    object(yield* reportKey(kind, periodEnd, sha256), 150_000),
    object(
      yield* recordKey(kind, periodEnd, sha256, FETCHED_AT, {
        filename: `file-${n}.zip`,
        etag: null,
      }),
      400
    ),
  ]
})

const rowsOf = (db: ReturnType<typeof memoryArchiveDb>) =>
  db.database
    .prepare("SELECT record_key, fetched_at, file_bytes FROM archived_report")
    .all() as Array<{
    record_key: string
    fetched_at: string
    file_bytes: number
  }>

describe("the report index's heal", () => {
  it.effect("indexes a record under its fetched-at as an ISO instant", () =>
    Effect.gen(function* () {
      const db = memoryArchiveDb()
      const objects = yield* report(0)

      yield* kseiIndex.heal(objects).pipe(Effect.provide(db.layer))

      assert.deepStrictEqual(rowsOf(db), [
        {
          record_key: objects[1]?.key ?? "",
          fetched_at: FETCHED_AT,
          file_bytes: 150_000,
        },
      ])
    })
  )

  it.effect("indexes a listing at MAX_LISTED_OBJECTS in chunks D1 takes", () =>
    Effect.gen(function* () {
      const db = memoryArchiveDb()
      const objects = (yield* Effect.forEach(
        Array.from({ length: MAX_LISTED_OBJECTS / 2 }, (_, n) => n),
        report
      )).flat()
      assert.strictEqual(objects.length, MAX_LISTED_OBJECTS)

      yield* kseiIndex.heal(objects).pipe(Effect.provide(db.layer))

      assert.strictEqual(rowsOf(db).length, MAX_LISTED_OBJECTS / 2)
      // Each statement is one json_each chunk of at most 90,000 bytes.
      for (const { params } of db.statements) {
        assert.isString(params[1])
        assert.isAtMost(
          new TextEncoder().encode(String(params[1])).length,
          90_000
        )
      }
    })
  )
})
