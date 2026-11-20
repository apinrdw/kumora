// The Done Details walk's store (done-details-walk.ts) in IndexedDB, so a
// restarted worker carries on: the tape walk's kept trades of one day, the
// walk's position, the rows of the code it is on, and the trades it has
// matched. A day's 1.5 M trades are too many for chrome.storage.
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import {
  DetailRow,
  DoneDetailsPosition,
  KeptTrade,
  MatchedTrade,
  type DoneDetailsStore,
} from "./done-details-walk.ts"

const DATABASE = "brokerCodesDoneDetails"
const TRADES = "trades"
const ROWS = "rows"
const MATCHED = "matched"
const META = "meta"
const STORES = [TRADES, ROWS, MATCHED, META]
const BY_CODE = "code"
const DAY_KEY = "day"
const POSITION_KEY = "position"

const decodeDay = Schema.decodeUnknownOption(WibDate)
const decodePosition = Schema.decodeUnknownOption(DoneDetailsPosition)
const decodeTrade = Schema.decodeUnknownOption(KeptTrade)
const decodeRow = Schema.decodeUnknownOption(DetailRow)
const decodeMatched = Schema.decodeUnknownOption(MatchedTrade)
const decodeCode = Schema.decodeUnknownOption(StockCode)

// Decision: version 2 holds the matched trades, keyed by trade number as a
// number so they read back in trade order, and each row's code. A version
// 1 database's walk is dropped whole: its kept trades have no side and its
// position no step, so the newest closed day's order numbers then come
// from Stockbit alone.
const openDatabase = Effect.callback<IDBDatabase>((resume) => {
  const request = indexedDB.open(DATABASE, 2)
  request.onupgradeneeded = () => {
    const db = request.result
    for (const name of Array.from(db.objectStoreNames))
      db.deleteObjectStore(name)
    db.createObjectStore(TRADES, { keyPath: "number" }).createIndex(
      BY_CODE,
      "code"
    )
    db.createObjectStore(ROWS, { autoIncrement: true }).createIndex(
      BY_CODE,
      "code"
    )
    db.createObjectStore(MATCHED)
    db.createObjectStore(META)
  }
  request.onsuccess = () => resume(Effect.succeed(request.result))
  request.onerror = () => resume(Effect.die(request.error))
})

// Decision: each operation is one transaction whose requests are all made
// from IndexedDB's own callbacks: a request made after an Effect resumes
// may find the transaction already committed. So `run` starts in the
// callback that read the stored day, which it is given.
const transact = <A>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (
    stores: {
      readonly trades: IDBObjectStore
      readonly rows: IDBObjectStore
      readonly matched: IDBObjectStore
      readonly meta: IDBObjectStore
    },
    stored: Option.Option<WibDate>,
    answer: (value: A) => void
  ) => void
) =>
  Effect.callback<A>((resume) => {
    const tx = db.transaction(STORES, mode)
    const stores = {
      trades: tx.objectStore(TRADES),
      rows: tx.objectStore(ROWS),
      matched: tx.objectStore(MATCHED),
      meta: tx.objectStore(META),
    }
    let value: A | undefined
    const day = stores.meta.get(DAY_KEY)
    day.onsuccess = () =>
      run(stores, decodeDay(day.result), (answered) => {
        value = answered
      })
    tx.oncomplete = () => resume(Effect.succeed(value as A))
    tx.onerror = () => resume(Effect.die(tx.error))
    tx.onabort = () => resume(Effect.die(tx.error))
  })

export const doneDetailsStore = Effect.gen(function* () {
  const database = yield* Effect.cached(openDatabase)
  const inTransaction = <A>(
    mode: IDBTransactionMode,
    run: Parameters<typeof transact<A>>[2]
  ) => Effect.flatMap(database, (db) => transact(db, mode, run))

  const store: DoneDetailsStore = {
    keep: (day, trades) =>
      inTransaction<void>("readwrite", (stores, stored) => {
        if (!Option.contains(stored, day)) {
          for (const each of Object.values(stores)) each.clear()
          stores.meta.put(day, DAY_KEY)
        }
        for (const trade of trades) stores.trades.put(trade)
      }),
    codes: (day) =>
      inTransaction<ReadonlyArray<StockCode>>(
        "readonly",
        (stores, stored, answer) => {
          const codes: Array<StockCode> = []
          answer(codes)
          if (!Option.contains(stored, day)) return
          const cursor = stores.trades
            .index(BY_CODE)
            .openKeyCursor(null, "nextunique")
          cursor.onsuccess = () => {
            const at = cursor.result
            if (at === null) return
            const code = decodeCode(at.key)
            if (Option.isSome(code)) codes.push(code.value)
            at.continue()
          }
        }
      ),
    trades: (day, code) =>
      inTransaction<ReadonlyArray<KeptTrade>>(
        "readonly",
        (stores, stored, answer) => {
          answer([])
          if (!Option.contains(stored, day)) return
          const request = stores.trades.index(BY_CODE).getAll(code)
          request.onsuccess = () =>
            answer(
              request.result.flatMap((each) =>
                Option.toArray(decodeTrade(each))
              )
            )
        }
      ),
    position: (day) =>
      inTransaction<Option.Option<DoneDetailsPosition>>(
        "readonly",
        (stores, stored, answer) => {
          answer(Option.none())
          if (!Option.contains(stored, day)) return
          const request = stores.meta.get(POSITION_KEY)
          request.onsuccess = () => answer(decodePosition(request.result))
        }
      ),
    // A code's rows are only ever its own pages', since `page` forgets them
    // at each code's first page.
    rows: (day, code) =>
      inTransaction<ReadonlyArray<DetailRow>>(
        "readonly",
        (stores, stored, answer) => {
          answer([])
          if (!Option.contains(stored, day)) return
          const request = stores.rows.index(BY_CODE).getAll(code)
          request.onsuccess = () =>
            answer(
              request.result.flatMap((each) => Option.toArray(decodeRow(each)))
            )
        }
      ),
    page: (day, next, rows) =>
      inTransaction<void>("readwrite", (stores, stored) => {
        if (!Option.contains(stored, day)) return
        if (next._tag !== "Walking" || next.page === 1) stores.rows.clear()
        if (next._tag === "Posted") stores.trades.clear()
        if (next._tag === "Walking")
          for (const row of rows) stores.rows.add({ ...row, code: next.code })
        stores.meta.put(next, POSITION_KEY)
      }),
    match: (day, trades) =>
      inTransaction<void>("readwrite", (stores, stored) => {
        if (!Option.contains(stored, day)) return
        for (const trade of trades)
          stores.matched.put(trade, Number(trade.number))
      }),
    matched: (day, after, limit) =>
      inTransaction<ReadonlyArray<MatchedTrade>>(
        "readonly",
        (stores, stored, answer) => {
          answer([])
          if (!Option.contains(stored, day)) return
          const request = stores.matched.getAll(
            IDBKeyRange.lowerBound(after, true),
            limit
          )
          request.onsuccess = () =>
            answer(
              request.result.flatMap((each) =>
                Option.toArray(decodeMatched(each))
              )
            )
        }
      ),
    clear: inTransaction<void>("readwrite", (stores) => {
      for (const each of Object.values(stores)) each.clear()
    }),
  }
  return store
})
