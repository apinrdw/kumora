// The Done Details walk's IndexedDB store, over fake-indexeddb: each test
// starts from an empty IndexedDB of its own.
import { afterEach, assert, describe, it, vi } from "@effect/vitest"
import {
  BrokerCode,
  OrderNumber,
  StockCode,
  TradeNumber,
  WibDate,
} from "@workspace/relay"
import { Effect, Option } from "effect"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"

import { doneDetailsStore } from "../../src/worker/broker-codes/done-details-store.ts"
import type {
  DetailRow,
  KeptTrade,
  MatchedTrade,
} from "../../src/worker/broker-codes/done-details-walk.ts"

const DAY = WibDate.make("2026-11-20")
const HOPE = StockCode.make("HOPE")
const TRADE: KeptTrade = {
  _tag: "Kept",
  number: TradeNumber.make("1"),
  code: HOPE,
  second: "10:23:18",
  board: "RG",
  price: 100,
  lots: 5,
  codes: {
    buyer: BrokerCode.make("YP"),
    buyerType: "D",
    seller: BrokerCode.make("PD"),
    sellerType: "F",
  },
}
const MATCHED: MatchedTrade = {
  number: TradeNumber.make("7"),
  codes: TRADE.codes,
  buy: OrderNumber.make(101),
  sell: OrderNumber.make(50),
}

const emptyIndexedDB = Effect.sync(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// A version 4 store as the walk before the 999 walk left it: on HOPE's
// third page, with a row of no offset, a tape trade and a matched trade.
const versionFour = Effect.callback<void>((resume) => {
  const request = indexedDB.open("brokerCodesDoneDetails", 4)
  request.onupgradeneeded = () => {
    const db = request.result
    db.createObjectStore("trades").createIndex("code", "code")
    db.createObjectStore("rows", { autoIncrement: true }).createIndex(
      "code",
      "code"
    )
    db.createObjectStore("matched")
    db.createObjectStore("meta")
  }
  request.onsuccess = () => {
    const db = request.result
    const tx = db.transaction(
      ["trades", "rows", "matched", "meta"],
      "readwrite"
    )
    tx.objectStore("meta").put(DAY, "day")
    tx.objectStore("meta").put(
      { _tag: "Walking", code: HOPE, page: 3 },
      "position"
    )
    tx.objectStore("trades").put(TRADE, Number(TRADE.number))
    tx.objectStore("rows").add({ _tag: "Unread", code: HOPE })
    tx.objectStore("matched").put(MATCHED, Number(MATCHED.number))
    tx.oncomplete = () => {
      db.close()
      resume(Effect.void)
    }
  }
})

describe("the Done Details store", () => {
  it.effect(
    "upgrades a version 4 store to walk its code again from the first page of the first pass, its rows gone and its trades kept",
    () =>
      Effect.gen(function* () {
        yield* emptyIndexedDB
        yield* versionFour
        const store = yield* doneDetailsStore
        assert.deepStrictEqual(
          yield* store.position(DAY),
          Option.some({
            _tag: "Walking",
            code: HOPE,
            pass: "first",
            page: 1,
          } as const)
        )
        assert.deepStrictEqual(yield* store.rows(DAY, HOPE), [])
        assert.deepStrictEqual(yield* store.trades(DAY, HOPE), [TRADE])
        assert.deepStrictEqual(yield* store.matched(DAY, Option.none(), 10), [
          MATCHED,
        ])
      })
  )

  it.effect(
    "answers a code's rows in the order its pages gave them, not by offset",
    () =>
      Effect.gen(function* () {
        yield* emptyIndexedDB
        const store = yield* doneDetailsStore
        yield* store.keep(DAY, [TRADE])
        const unread = (offset: number): DetailRow => ({
          _tag: "Unread",
          offset,
        })
        yield* store.page(
          DAY,
          { _tag: "Walking", code: HOPE, pass: "first", page: 1 },
          []
        )
        yield* store.page(
          DAY,
          { _tag: "Walking", code: HOPE, pass: "first", page: 2 },
          [unread(5), unread(2)]
        )
        yield* store.page(
          DAY,
          { _tag: "Walking", code: HOPE, pass: "second", page: 1 },
          [unread(9), unread(0)]
        )
        assert.deepStrictEqual(yield* store.rows(DAY, HOPE), [
          unread(5),
          unread(2),
          unread(9),
          unread(0),
        ])
      })
  )
})
