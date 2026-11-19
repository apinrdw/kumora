// The daily Special Monitoring Board run: IDX's special-notation list, its
// `X` codes, replace the special_board table in one batch, unless the run
// fails the sanity gate, which keeps yesterday's table whole.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

import {
  SPECIAL_NOTATION_URL,
  syncSpecialBoard,
} from "@/server/special-board/sync"

import { memoryHoldingsDb } from "../holdings/memory-holdings-db.ts"

interface Notation {
  readonly EmitenCode: string
  readonly Notation: string
}

// A row as IDX lists it on 2026-11-18, every field.
const notation = (code: string, notations = "E,X") => ({
  Id: 1,
  EmitenCode: code,
  Notation: notations,
  Remarks: "-------------------E---------X",
  Date: "2026-11-17T00:00:00",
  Description: "X : Listed Company is listed on the Watchlist Board",
  Language: "English",
})

const codes = (n: number, prefix = "B") =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`)

const setup = () => {
  const idx = {
    rows: new Array<Notation>(),
    response: undefined as (() => Response) | undefined,
    requests: new Array<string>(),
  }
  const db = memoryHoldingsDb()
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        idx.requests.push(url.href)
        return HttpClientResponse.fromWeb(
          request,
          idx.response?.() ??
            Response.json({
              SearchCriteria: {
                Language: "en-us",
                indexfrom: 1,
                pagesize: 9999,
              },
              ResultCount: idx.rows.length,
              Results: idx.rows,
            })
        )
      })
    )
  )
  return { idx, db, layer: Layer.merge(http, db.layer) }
}

const rows = (db: ReturnType<typeof memoryHoldingsDb>) =>
  db.database
    .prepare(
      "SELECT code, notation, fetched_at FROM special_board ORDER BY code"
    )
    .all()
    .map((row) => ({ ...row }))

const yesterday = new Date("2026-11-17T16:00:00Z")
const today = new Date("2026-11-18T16:00:00Z")

describe("the Special Monitoring Board run", () => {
  it.effect(
    "replaces the table with the codes whose notation includes X",
    () => {
      const { idx, db, layer } = setup()
      return Effect.gen(function* () {
        idx.rows = codes(30, "Y").map((code) => notation(code))
        yield* syncSpecialBoard(yesterday)
        idx.rows = [
          notation("WSBP", "E,X"),
          notation("OCAP", " E,D,S,X "),
          // Notations without X trade on a regular board.
          notation("DPUM", "L"),
          notation("BBXA", "E,L,Y"),
          ...codes(20).map((code) => notation(code, "X")),
        ]
        const outcome = yield* syncSpecialBoard(today)

        assert.deepStrictEqual(outcome, { _tag: "Replaced", codes: 22 })
        assert.strictEqual(idx.requests.at(-1), SPECIAL_NOTATION_URL)
        const stored = rows(db)
        assert.lengthOf(stored, 22)
        assert.deepStrictEqual(
          stored.filter(({ code }) => code === "OCAP" || code === "WSBP"),
          [
            {
              code: "OCAP",
              notation: "E,D,S,X",
              fetched_at: "2026-11-18T16:00:00.000Z",
            },
            {
              code: "WSBP",
              notation: "E,X",
              fetched_at: "2026-11-18T16:00:00.000Z",
            },
          ]
        )
        assert.isFalse(stored.some(({ code }) => String(code).startsWith("Y")))
        // One batch: the old rows go and the new come in one transaction.
        assert.strictEqual(
          db.statements.filter(({ sql }) => sql.startsWith("DELETE")).length,
          2
        )
      }).pipe(Effect.provide(layer))
    }
  )

  it.effect("keeps yesterday's table under 20 or over 200 codes", () => {
    const { idx, db, layer } = setup()
    return Effect.gen(function* () {
      idx.rows = codes(59).map((code) => notation(code))
      yield* syncSpecialBoard(yesterday)

      idx.rows = codes(19).map((code) => notation(code))
      assert.deepStrictEqual(yield* syncSpecialBoard(today), {
        _tag: "Kept",
        reason:
          "IDX lists 19 Special Monitoring Board codes, outside the 20–200 the gate accepts",
      })
      idx.rows = codes(201).map((code) => notation(code))
      assert.strictEqual((yield* syncSpecialBoard(today))._tag, "Kept")
      assert.lengthOf(rows(db), 59)
      assert.isTrue(
        rows(db).every(
          ({ fetched_at }) => fetched_at === "2026-11-17T16:00:00.000Z"
        )
      )

      // Both bounds pass.
      for (const n of [20, 200]) {
        idx.rows = codes(n).map((code) => notation(code))
        assert.deepStrictEqual(yield* syncSpecialBoard(today), {
          _tag: "Replaced",
          codes: n,
        })
      }
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps yesterday's table when a board code isn't valid", () => {
    const { idx, db, layer } = setup()
    return Effect.gen(function* () {
      idx.rows = codes(30).map((code) => notation(code))
      yield* syncSpecialBoard(yesterday)
      idx.rows = [
        ...codes(30, "C").map((code) => notation(code)),
        notation("bad code"),
      ]
      assert.deepStrictEqual(yield* syncSpecialBoard(today), {
        _tag: "Kept",
        reason:
          'IDX lists a Special Monitoring Board code that isn\'t a stock code: "bad code"',
      })
      assert.isTrue(rows(db).every(({ code }) => String(code).startsWith("B")))
    }).pipe(Effect.provide(layer))
  })

  it.effect("fails, and keeps the table, when IDX answers an error", () => {
    const { idx, db, layer } = setup()
    return Effect.gen(function* () {
      idx.rows = codes(30).map((code) => notation(code))
      yield* syncSpecialBoard(yesterday)
      idx.response = () => new Response("Service unavailable", { status: 503 })
      const failed = yield* Effect.flip(syncSpecialBoard(today))

      assert.include(failed.message, "503")
      assert.lengthOf(rows(db), 30)
    }).pipe(Effect.provide(layer))
  })

  it.effect("fails, and keeps the table, when IDX changes the shape", () => {
    const { idx, db, layer } = setup()
    return Effect.gen(function* () {
      idx.rows = codes(30).map((code) => notation(code))
      yield* syncSpecialBoard(yesterday)
      idx.response = () => Response.json({ data: [] })
      const failed = yield* Effect.flip(syncSpecialBoard(today))

      assert.include(failed.message, "Schema")
      assert.lengthOf(rows(db), 30)
    }).pipe(Effect.provide(layer))
  })
})
