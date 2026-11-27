// The Holder map's custodians (spec apinrdw/kumora#733, "Custodian
// identity"; apinrdw/kumora#739): one node per broker code, else per name,
// each above-5% holding's shares at each, and a custodian focus's spellings
// of the day.
//
// Decision: broker codes are looked up on read
// (apps/dashboard/docs/adr/0132-broker-codes-are-looked-up-on-read.md)
import type { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { CustodianId, type HolderKey } from "@/domain/holdings"
import { brokerOf, memberName } from "@/lib/broker-code"
import { placeOf } from "@/lib/holder-map-ids"

import { decodeRows } from "../d1.ts"
import { HoldingsDb } from "./db.ts"
import { holderKey } from "./holder-key.ts"
import {
  type Budgeted,
  DAY_ROWS,
  type HolderMapCustodianLink,
  PERIODS,
  PERIODS_SQL,
  PeriodsRow,
} from "./holder-map-schema.ts"

// A securities account as a custodian link reads it.
export interface Account {
  readonly custodian: string
  readonly scripless: number
}

// A 5%-band holding's securities accounts.
export interface HoldingAccounts {
  readonly code: StockCode
  readonly holder: HolderKey
  readonly accounts: ReadonlyArray<Account>
}

export const SpellingRow = Schema.Struct({ custodian: Schema.String })

// A name-keyed custodian's id starts with this, so a custodian with no
// code whose name keys to two letters (`PT ZP`) is never a broker's.
const BY_NAME = "NAME:"

// A custodian as one node: by the broker code its name looks up, else by
// its name keyed as a holder's, as typed in any case or punctuation. The
// URL's `?custodian=` uppercases what it is given, as both are.
export const custodianOf = Effect.fnUntraced(function* (custodian: string) {
  const broker = yield* brokerOf(custodian)
  const key = yield* holderKey(custodian)
  return {
    id: CustodianId.make(
      broker ?? `${BY_NAME}${key === "" ? custodian.trim().toUpperCase() : key}`
    ),
    broker,
    member: broker === undefined ? undefined : yield* memberName(broker),
  }
})

// Each custodian's name: its member's as IDX lists it, else the first of
// `spellings` in code-point order, so one custodian reads one name
// whichever stocks are in view.
export const custodianNames = Effect.fnUntraced(function* (
  spellings: Iterable<string>
) {
  const names = new Map<CustodianId, string>()
  for (const spelling of [...spellings].sort()) {
    const { id, member } = yield* custodianOf(spelling)
    if (!names.has(id)) names.set(id, member ?? spelling)
  }
  return names
})

// Each holding's shares at each custodian, its accounts there summed, by
// stock, holder and custodian. An account emptied to 0 shares holds
// nothing there.
export const custodianLinks = Effect.fnUntraced(function* (
  holdings: ReadonlyArray<HoldingAccounts>
) {
  const spellings = new Set<string>()
  const summed = new Map<string, Omit<HolderMapCustodianLink, "name">>()
  for (const { code, holder, accounts } of holdings)
    for (const { custodian, scripless } of accounts) {
      if (scripless <= 0) continue
      spellings.add(custodian)
      const { id, broker } = yield* custodianOf(custodian)
      const place = `${yield* placeOf(code, holder)} ${id}`
      const known = summed.get(place)
      summed.set(place, {
        code,
        holder,
        custodian: id,
        broker,
        shares: (known?.shares ?? 0) + scripless,
      })
    }
  const names = yield* custodianNames(spellings)
  return [...summed.values()]
    .map((link): HolderMapCustodianLink => ({
      ...link,
      name: names.get(link.custodian) ?? link.custodian,
    }))
    .sort(
      (a, b) =>
        a.code.localeCompare(b.code) ||
        a.holder.localeCompare(b.holder) ||
        a.custodian.localeCompare(b.custodian)
    )
})

// The custodian names of the map's day: at most its accounts.
export const DAY_SPELLINGS_SQL = {
  sql: `${PERIODS}
  SELECT DISTINCT custodian FROM above_5_account
  WHERE data_date = (SELECT day FROM asof)`,
  rows: DAY_ROWS,
} satisfies Budgeted

// A custodian focus's spellings: the day's custodian names whose id is
// the focus's, and the day the map is drawn as of, so the read that uses
// them reads that day. The rest of the map is read in a batch after, so a
// parse run replacing the day between the two can leave out a spelling
// only its new version has.
export const custodianSpellings = Effect.fnUntraced(function* (
  id: CustodianId,
  asked: WibDate | null
) {
  const [periodRows = [], spellingRows = []] = yield* (yield* HoldingsDb).batch(
    [
      { ...PERIODS_SQL, params: [asked] },
      // A day's rows, within its parse cap (ADR 0045), by its key.
      { ...DAY_SPELLINGS_SQL, params: [asked] },
    ]
  )
  const [periods] = yield* decodeRows(PeriodsRow)(periodRows)
  const spellings: Array<string> = []
  for (const { custodian } of yield* decodeRows(SpellingRow)(spellingRows))
    if ((yield* custodianOf(custodian)).id === id) spellings.push(custodian)
  return { day: periods?.day ?? asked, spellings }
})
