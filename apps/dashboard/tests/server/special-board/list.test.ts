// The board list the dashboard serves at SpecialBoardPath: every stored
// code, and when the table was read.
import { assert, describe, it } from "@effect/vitest"
import { decodeSpecialBoard } from "@workspace/relay"
import { Effect } from "effect"

import { specialBoardBody } from "@/server/special-board/list"

import { memoryHoldingsDb } from "../holdings/memory-holdings-db.ts"

describe("the Special Monitoring Board list", () => {
  it.effect("lists every stored code, in order, with when it was read", () => {
    const db = memoryHoldingsDb()
    const add = db.database.prepare(
      "INSERT INTO special_board VALUES (?, ?, '2026-11-18T16:00:00.000Z')"
    )
    add.run("WSBP", "E,X")
    add.run("LAPD", "E,L,X")
    return Effect.gen(function* () {
      const board = yield* decodeSpecialBoard(yield* specialBoardBody)
      assert.deepStrictEqual<unknown>(board, {
        fetchedAt: "2026-11-18T16:00:00.000Z",
        codes: ["LAPD", "WSBP"],
      })
    }).pipe(Effect.provide(db.layer))
  })

  it.effect("is empty, with no date, before the first run", () => {
    const db = memoryHoldingsDb()
    return Effect.gen(function* () {
      const board = yield* decodeSpecialBoard(yield* specialBoardBody)
      assert.deepStrictEqual(board, { fetchedAt: null, codes: [] })
    }).pipe(Effect.provide(db.layer))
  })
})
