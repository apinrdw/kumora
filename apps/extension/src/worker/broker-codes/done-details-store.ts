// The Done Details walk's store (done-details-walk.ts) in IndexedDB, so a
// restarted worker carries on: the tape walk's kept trades of one day, the
// walk's position, and the rows of the code it is on. A day's 1.5 M trades
// are too many for chrome.storage.
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Option, Schema } from "effect"

import {
  DetailRow,
  DoneDetailsPosition,
  KeptTrade,
  type DoneDetailsStore,
} from "./done-details-walk.ts"

const DATABASE = "brokerCodesDoneDetails"
const TRADES = "trades"
const ROWS = "rows"
const META = "meta"
const BY_CODE = "code"
const DAY_KEY = "day"
const POSITION_KEY = "position"

const decodeDay = Schema.decodeUnknownOption(WibDate)
const decodePosition = Schema.decodeUnknownOption(DoneDetailsPosition)
const decodeTrade = Schema.decodeUnknownOption(KeptTrade)
const decodeRow = Schema.decodeUnknownOption(DetailRow)
const decodeCode = Schema.decodeUnknownOption(StockCode)

const openDatabase = Effect.callback<IDBDatabase>((resume) => {
  const request = indexedDB.open(DATABASE, 1)
  request.onupgradeneeded = () => {
    const db = request.result
    db.createObjectStore(TRADES, { keyPath: "number" }).createIndex(
      BY_CODE,
      "code"
    )
    db.createObjectStore(ROWS, { autoIncrement: true })
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
      readonly meta: IDBObjectStore
    },
    stored: Option.Option<WibDate>,
    answer: (value: A) => void
  ) => void
) =>
  Effect.callback<A>((resume) => {
    const tx = db.transaction([TRADES, ROWS, META], mode)
    const stores = {
      trades: tx.objectStore(TRADES),
      rows: tx.objectStore(ROWS),
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
          stores.trades.clear()
          stores.rows.clear()
          stores.meta.clear()
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
    rows: (day, code) =>
      inTransaction<ReadonlyArray<DetailRow>>(
        "readonly",
        (stores, stored, answer) => {
          answer([])
          if (!Option.contains(stored, day)) return
          const position = stores.meta.get(POSITION_KEY)
          position.onsuccess = () => {
            const at = decodePosition(position.result)
            if (!Option.exists(at, (each) => each.code === code)) return
            const request = stores.rows.getAll()
            request.onsuccess = () =>
              answer(
                request.result.flatMap((each) =>
                  Option.toArray(decodeRow(each))
                )
              )
          }
        }
      ),
    page: (day, next, rows) =>
      inTransaction<void>("readwrite", (stores, stored) => {
        if (!Option.contains(stored, day)) return
        const position = stores.meta.get(POSITION_KEY)
        position.onsuccess = () => {
          const at = decodePosition(position.result)
          if (!Option.exists(at, (each) => each.code === next.code))
            stores.rows.clear()
          for (const row of rows) stores.rows.add(row)
          stores.meta.put(next, POSITION_KEY)
        }
      }),
    clear: inTransaction<void>("readwrite", (stores) => {
      stores.trades.clear()
      stores.rows.clear()
      stores.meta.clear()
    }),
  }
  return store
})
