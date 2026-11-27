// The Holder map's one rule of which stored rows it draws, in SQL, against
// the schemas the read decodes with, and an identity's key in SQL against
// the identities Holder moves gives (codex review of apinrdw/kumora#741,
// round 12).
import { DatabaseSync } from "node:sqlite"

import { assert, describe, it } from "@effect/vitest"
import { StockCode } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { HolderKey } from "@/domain/holdings"
import { holderKey } from "@/server/holdings/holder-key"
import { drawable, identityKey } from "@/server/holdings/holder-map-schema"

const database = new DatabaseSync(":memory:")

// The SQL `expression` of ?, on `value`.
const sqlOf = (expression: string, value: string) =>
  (
    database
      .prepare(`SELECT ${expression} AS out FROM (SELECT ? AS v)`)
      .get(value) as { out: unknown }
  ).out

const CODES = [
  "BBCA",
  "B",
  "BREN-W",
  "-",
  "0",
  "COMPOSITE",
  "ID.IHSG",
  "ID.",
  "I.IHSG",
  "IDX.IHSG",
  "id.IHSG",
  "ID.IH.SG",
  "ID-IHSG",
  ".BBCA",
  "BBCA.",
  "",
  " ",
  "BBCA ",
  " BBCA",
  "BAD CODE",
  "bbca",
  "BBCÄ",
  "BB_CA",
  "BB*A",
  "BB?A",
  "BB[A",
  "BB]A",
  "BB^A",
  "AAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAA",
  "ID.AAAAAAAAAAAAA",
  "ID.AAAAAAAAAAAAAA",
  "BB\nCA",
  "BBCA\n",
]

const KEYS = [
  "AGUNG INVESTINDO PERKASA",
  "#1 FUND",
  "A",
  "",
  " ",
  "  ",
  "\t",
  "\n",
  "\r\n",
  " ",
  "　",
  "﻿",
  " ",
  " ",
  "​",
  " A ",
  "A".repeat(256),
  "A".repeat(257),
  "É".repeat(256),
]

describe("Holder map, the rows it draws", () => {
  it("takes a code as a stock code exactly where the schema does", () => {
    const isStockCode = Schema.is(StockCode)
    for (const code of CODES)
      assert.strictEqual(
        sqlOf(drawable({ code: "v" }), code) === 1,
        isStockCode(code),
        JSON.stringify(code)
      )
  })

  it("takes a key as a holder key exactly where the schema does", () => {
    const isHolderKey = Schema.is(HolderKey)
    for (const key of KEYS)
      assert.strictEqual(
        sqlOf(drawable({ code: "'BBCA'", key: "v" }), key) === 1,
        isHolderKey(key),
        JSON.stringify(key)
      )
  })

  it.effect(
    "reads an identity's key as the key it was first listed under",
    () =>
      Effect.gen(function* () {
        for (const name of [
          "PT AGUNG PERKASA INVESTINDO",
          "FUND #1",
          "FUND #12 #3",
          "FUND#",
          "REKSA DANA 2",
          "#",
        ]) {
          const key = yield* holderKey(name)
          for (const n of [1, 2, 10, 123])
            assert.strictEqual(
              sqlOf(identityKey("v"), `${key}#${n}`),
              key,
              `${name}, #${n}`
            )
        }
      })
  )
})
