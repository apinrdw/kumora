import { describe, expect, it } from "@effect/vitest"
import { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Effect } from "effect"

import { CustodianId, HolderKey } from "@/domain/holdings"

import {
  holderMapMoveSearch,
  parseHolderMapSearch,
  findFoci,
  queryOf,
  refocused,
} from "@/lib/holder-map-search"

describe("parseHolderMapSearch", () => {
  it.effect("keeps a stock focus, in any case, and an as-of day", () =>
    Effect.gen(function* () {
      const search = yield* parseHolderMapSearch({
        stock: "true",
        day: "2026-06-25",
      })
      expect(search).toEqual({
        stock: "TRUE",
        holder: undefined,
        custodian: undefined,
        day: "2026-06-25",
      })
      expect(yield* queryOf(search)).toEqual({
        focus: { kind: "stock", code: "TRUE" },
        day: "2026-06-25",
      })
    })
  )

  it.effect("keeps a holder focus by its key", () =>
    Effect.gen(function* () {
      const search = yield* parseHolderMapSearch({
        holder: "INDONESIA MAYBANK SEKURITAS",
      })
      expect(search).toEqual({
        stock: undefined,
        holder: "INDONESIA MAYBANK SEKURITAS",
        custodian: undefined,
        day: undefined,
      })
      expect(yield* queryOf(search)).toEqual({
        focus: { kind: "holder", key: "INDONESIA MAYBANK SEKURITAS" },
        day: undefined,
      })
    })
  )

  it.effect("drops both foci when the URL names a stock and a holder", () =>
    Effect.gen(function* () {
      const search = yield* parseHolderMapSearch({
        stock: "TRUE",
        holder: "DJONI",
        day: "2026-06-25",
      })
      expect(search).toEqual({
        stock: undefined,
        holder: undefined,
        custodian: undefined,
        day: "2026-06-25",
      })
    })
  )

  it.effect("keeps a custodian focus by its id, in any case", () =>
    Effect.gen(function* () {
      const search = yield* parseHolderMapSearch({ custodian: "zp" })
      expect(search).toEqual({
        stock: undefined,
        holder: undefined,
        custodian: "ZP",
        day: undefined,
      })
      expect(yield* queryOf(search)).toEqual({
        focus: { kind: "custodian", id: "ZP" },
        day: undefined,
      })
    })
  )

  it.effect(
    "drops every focus when the URL names a custodian and another",
    () =>
      Effect.gen(function* () {
        for (const other of [{ stock: "TRUE" }, { holder: "DJONI" }])
          expect(
            yield* parseHolderMapSearch({ custodian: "ZP", ...other })
          ).toEqual({
            stock: undefined,
            holder: undefined,
            custodian: undefined,
            day: undefined,
          })
      })
  )

  it.effect("drops a blank or overlong holder key", () =>
    Effect.gen(function* () {
      for (const holder of ["  ", "X".repeat(257), 7])
        expect((yield* parseHolderMapSearch({ holder })).holder).toBe(undefined)
    })
  )

  it.effect("drops what doesn't parse, leaving the landing view", () =>
    Effect.gen(function* () {
      const search = yield* parseHolderMapSearch({
        stock: "no such code!",
        day: "2026-02-30",
        other: "x",
      })
      expect(search).toEqual({
        stock: undefined,
        holder: undefined,
        custodian: undefined,
        day: undefined,
      })
      expect(yield* queryOf(search)).toEqual({
        focus: undefined,
        day: undefined,
      })
    })
  )
})

describe("refocused", () => {
  it.effect("clears the stock when focusing a holder, keeping the day", () =>
    Effect.gen(function* () {
      const next = yield* refocused(
        { stock: StockCode.make("TRUE"), day: WibDate.make("2026-06-25") },
        { holder: HolderKey.make("DJONI") }
      )
      expect(yield* queryOf(next)).toEqual({
        focus: { kind: "holder", key: "DJONI" },
        day: "2026-06-25",
      })
    })
  )

  it.effect("clears the stock when focusing a custodian, and back", () =>
    Effect.gen(function* () {
      const custodian = yield* refocused(
        { stock: StockCode.make("TRUE"), day: WibDate.make("2026-06-25") },
        { custodian: CustodianId.make("YP") }
      )
      expect(yield* queryOf(custodian)).toEqual({
        focus: { kind: "custodian", id: "YP" },
        day: "2026-06-25",
      })
      expect(
        yield* queryOf(
          yield* refocused(custodian, { holder: HolderKey.make("DJONI") })
        )
      ).toEqual({
        focus: { kind: "holder", key: "DJONI" },
        day: "2026-06-25",
      })
    })
  )

  it.effect("clears the holder when focusing a stock", () =>
    Effect.gen(function* () {
      const next = yield* refocused(
        { holder: HolderKey.make("DJONI") },
        { stock: StockCode.make("TRUE") }
      )
      expect(yield* queryOf(next)).toEqual({
        focus: { kind: "stock", code: "TRUE" },
        day: undefined,
      })
    })
  )
})

describe("holderMapMoveSearch", () => {
  const TRUE = StockCode.make("TRUE")

  it.effect("focuses a Daily row's stock as of the row's day", () =>
    Effect.gen(function* () {
      expect(
        yield* holderMapMoveSearch("daily", TRUE, WibDate.make("2026-11-20"))
      ).toEqual({
        stock: "TRUE",
        day: "2026-11-20",
      })
    })
  )

  it.effect("opens a Monthly row's stock on the newest day", () =>
    Effect.gen(function* () {
      expect(
        yield* holderMapMoveSearch("monthly", TRUE, WibDate.make("2026-10-30"))
      ).toEqual({ stock: "TRUE" })
    })
  )
})

describe("findFoci", () => {
  const list = {
    stocks: [
      { code: StockCode.make("BSDE"), issuerName: "BUMI SERPONG DAMAI Tbk" },
      { code: StockCode.make("MAYA"), issuerName: "BANK MAYAPADA" },
      { code: StockCode.make("TRUE"), issuerName: "TRINITI DINAMIK Tbk, PT" },
    ],
    holders: [
      {
        key: "INDONESIA MAYBANK SEKURITAS",
        name: "MAYBANK SEKURITAS INDONESIA",
      },
      { key: "AGUNG INVESTINDO PERKASA", name: "PT AGUNG PERKASA INVESTINDO" },
    ],
    custodians: [
      {
        id: "A CITIBANK N",
        broker: undefined,
        name: "CITIBANK, N. A",
      },
      {
        id: "ZP",
        broker: BrokerCode.make("ZP"),
        name: "MAYBANK SEKURITAS INDONESIA",
      },
    ],
  }
  const found = (query: string, shown = 50) =>
    Effect.map(findFoci(list, query, shown), (foci) =>
      foci.map((focus) =>
        focus.kind === "stock"
          ? focus.code
          : focus.kind === "holder"
            ? `holder ${focus.key}`
            : `custodian ${focus.id}`
      )
    )

  it.effect(
    "finds stocks by code first, then by name, then custodians, then holders",
    () =>
      Effect.gen(function* () {
        expect(yield* found("may")).toEqual([
          "MAYA",
          "custodian ZP",
          "holder INDONESIA MAYBANK SEKURITAS",
        ])
        expect(yield* found("dinamik")).toEqual(["TRUE"])
      })
  )

  it.effect("finds a custodian by its broker code or its name", () =>
    Effect.gen(function* () {
      expect(yield* found("zp")).toEqual(["custodian ZP"])
      expect(yield* found("citibank")).toEqual(["custodian A CITIBANK N"])
    })
  )

  it.effect("finds a holder by every word typed, in any order", () =>
    Effect.gen(function* () {
      expect(yield* found("investindo agung")).toEqual([
        "holder AGUNG INVESTINDO PERKASA",
      ])
      expect(yield* found("agung bumi")).toEqual([])
    })
  )

  it.effect(
    "lists the stocks for an empty search, at most as many as shown",
    () =>
      Effect.gen(function* () {
        expect(yield* found("  ", 2)).toEqual(["BSDE", "MAYA"])
      })
  )
})
