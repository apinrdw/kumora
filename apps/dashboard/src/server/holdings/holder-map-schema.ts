// What the Holder map's read returns (spec apinrdw/kumora#733, "Holder map
// read"), and the day and month it is drawn as of.
import { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import {
  CustodianId,
  HolderKey,
  type HolderMapQuery,
  KseiType,
  SplitOrigin,
} from "@/domain/holdings"

import { decodeRows } from "../d1.ts"
import { MAX_HOLDING_ROWS } from "./above-1.ts"
import { MAX_ROWS } from "./above-5.ts"
import { holderKey } from "./holder-key.ts"

export type Focus = NonNullable<HolderMapQuery["focus"]>

// A holder's move against its band's period before: the trading day before
// for the 5% band, the month before for the 1% band, as Holder moves'
// derivation stored it.
export const HolderMapMove = Schema.Struct({
  kind: Schema.Literals(["new", "up", "down", "transfer"]),
  // In shares: a New holder's whole holding.
  shareChange: Schema.UndefinedOr(Schema.Number),
  // % × 100; undefined on a New holder.
  percentageChange: Schema.UndefinedOr(Schema.Number),
})

// A holder that crossed 5% between the bands' periods: under 5% in the
// month and on the day's above-5% list, or off that list since a day after
// the month and still a ≥1% holder of it. It shows this, not its move.
const HolderMapCrossing = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("up into 5%"),
    // Its % × 100 in the month.
    monthHundredths: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("down out of 5%"),
    // The trading day it left the above-5% list.
    since: WibDate,
  }),
])

// One holding: a holder of a stock, in one band.
export const HolderMapLink = Schema.Struct({
  code: StockCode,
  // The 5%-and-above band (the day's above-5% holders) or the 1%-to-5% band
  // (the month's ≥1% holders that aren't).
  band: Schema.Literals(["5%", "1%"]),
  // Its holder key: one holder across stocks and reports.
  holder: HolderKey,
  // Its first block's or row's name as published.
  name: Schema.String,
  // % of listed shares × 100.
  percentageHundredths: Schema.Number,
  // Scripless on the 5% band; scrip included on the 1% band.
  shares: Schema.Number,
  // Mixed when its accounts' or rows' origins differ; undefined when none
  // publishes one (a scrip account).
  origin: Schema.UndefinedOr(
    Schema.Literals([...SplitOrigin.literals, "mixed"])
  ),
  // From its ≥1% rows; undefined when none publishes one, as on a 5%-band
  // holder missing from the month.
  investorType: Schema.UndefinedOr(KseiType),
  // Undefined when it holds as it did, or nothing is compared.
  move: Schema.UndefinedOr(HolderMapMove),
  // A gap holder: in the 1% band at 5% or more in the month, with no
  // above-5% holder of its key on the day.
  gap: Schema.Boolean,
  crossing: Schema.UndefinedOr(HolderMapCrossing),
})
export type HolderMapLink = typeof HolderMapLink.Type

// A link before its changes are read.
export type StockLink = Omit<HolderMapLink, "move" | "gap" | "crossing">

// A holding the focus left: a stock focus's holder, or a holder focus's
// stock, off the day's above-5% list or the month's ≥1% list.
const HolderMapOffList = Schema.Struct({
  code: StockCode,
  // The report it left: the 5% band's or the 1% band's.
  band: HolderMapLink.fields.band,
  holder: HolderKey,
  // Its last listing's name.
  name: Schema.String,
  // The period it left, the first it was missing from: a trading day or an
  // above-1% report.
  since: WibDate,
  // Its last listing's %, × 100.
  percentageHundredths: Schema.Number,
})
export type HolderMapOffList = typeof HolderMapOffList.Type

// An above-5% holding's shares at one custodian: its securities accounts
// there, summed.
const HolderMapCustodianLink = Schema.Struct({
  // The holding's stock and holder key.
  code: StockCode,
  holder: HolderKey,
  custodian: CustodianId,
  // Undefined for a bank or other custodian no exchange member is.
  broker: Schema.UndefinedOr(BrokerCode),
  // The member's name as IDX lists it, else its first spelling in view.
  name: Schema.String,
  // Scripless.
  shares: Schema.Number,
})
export type HolderMapCustodianLink = typeof HolderMapCustodianLink.Type

const HolderMapFocus = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("stock"),
    code: StockCode,
    // As the day's or the month's report prints it; undefined when
    // neither lists the stock.
    issuerName: Schema.UndefinedOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("holder"),
    key: HolderKey,
    // Its largest holding's name as published, else its latest Off list
    // name; undefined when neither report lists the key.
    name: Schema.UndefinedOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("custodian"),
    id: CustodianId,
    broker: HolderMapCustodianLink.fields.broker,
    // As its links name it; undefined when no account of the day is
    // there.
    name: Schema.UndefinedOr(Schema.String),
  }),
])
export type HolderMapFocus = typeof HolderMapFocus.Type

export const HolderMapRead = Schema.Struct({
  // The 5% band's trading day: the one asked for, else the newest;
  // undefined when it is refused or no above-5% day is parsed.
  day: Schema.UndefinedOr(WibDate),
  // The day asked for when no above-5% report of it is parsed: the map is
  // then drawn as of no day, with no links and no stocks.
  refused: Schema.UndefinedOr(WibDate),
  // Every parsed above-5% day, oldest first: the as-of picker's days.
  days: Schema.Array(WibDate),
  // The 1% band's above-1% report: the newest on or before the day.
  month: Schema.UndefinedOr(WibDate),
  focus: Schema.UndefinedOr(HolderMapFocus),
  // The first hop: a stock focus's holders, or a holder focus's stocks.
  links: Schema.Array(HolderMapLink),
  // The second hop: each first-hop holder's other stocks, or each
  // first-hop stock's other holders, every one, uncapped.
  hops: Schema.Array(HolderMapLink),
  // Each 5%-band link of the two hops at each of its custodians, by stock,
  // holder and custodian.
  custodians: Schema.Array(HolderMapCustodianLink),
  // Each stock the links and the Off list reach, by code, with its issuer
  // name as its report prints it.
  issuers: Schema.Array(
    Schema.Struct({ code: StockCode, issuerName: Schema.String })
  ),
  // The focus's earlier holdings: off their list in their band's period and
  // in neither band now, each once, by its latest leaving. None without a
  // focus.
  offList: Schema.Array(HolderMapOffList),
  // Whether older leavings were left out of the Off list: it reads only
  // the newest, a day's accounts at the above-5% parse's cap (ADR 0133).
  offListCut: Schema.Boolean,
  // With no focus, the stocks with the most ≥1% holders in the month; none
  // with a focus.
  mostHeld: Schema.Array(
    Schema.Struct({
      code: StockCode,
      issuerName: Schema.String,
      holders: Schema.Number,
    })
  ),
})
export type HolderMapRead = typeof HolderMapRead.Type

// A statement of the Holder map's reads and the most rows it returns: a
// budget in the parse caps (ADR 0045), which no number of periods parsed
// raises. Rows the Worker decodes are at most the budgets' sum, however
// the statement's scans grow. tests/server/holdings/holder-map-heap.test.ts
// holds each statement to its budget.
//
// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
export interface Budgeted {
  readonly sql: string
  readonly rows: number
}

// An above-5% day's rows at the parse's cap: its blocks, or its
// securities accounts.
export const DAY_ROWS = MAX_ROWS

// An above-1% month's rows at the parse's cap.
export const MONTH_ROWS = MAX_HOLDING_ROWS

// The day the map is drawn as of, `asof`, and the 1% band's month,
// `band_month`. ?1 is the day asked for, null for the newest; a day asked
// for that has no above-5% report leaves both null, so nothing is read.
// With no above-5% day parsed, the newest month is the 1% band's.
export const PERIODS = `WITH asof AS (
    SELECT CASE WHEN ?1 IS NULL
      THEN (SELECT MAX(data_date) FROM above_5_day)
      ELSE (SELECT data_date FROM above_5_day WHERE data_date = ?1)
    END AS day
  ),
  band_month AS (
    SELECT MAX(data_date) AS month FROM above_1_month
    WHERE data_date <= (SELECT day FROM asof)
      OR (?1 IS NULL AND (SELECT day FROM asof) IS NULL)
  )`

// The day and the month the map is drawn as of.
export const PERIODS_SQL = {
  sql: `${PERIODS}
  SELECT (SELECT day FROM asof) AS day, (SELECT month FROM band_month) AS month`,
  rows: 1,
} satisfies Budgeted

export const PeriodsRow = Schema.Struct({
  day: Schema.NullOr(WibDate),
  month: Schema.NullOr(WibDate),
})

const isStockCode = Schema.is(StockCode)
const isHolderKey = Schema.is(HolderKey)

// A statement's rows as `row`s, each whose stored `stock_code` or
// `holder_key` isn't of its shape left out. The parsers only trim a code
// and cap its length, and key a name of legal-form words blank, so one
// report's bad row must not fail a read of every other. Every Holder map
// statement that returns a stored code or key is read through this.
export const storedRows = <A, I>(row: Schema.Codec<A, I>) => {
  const decode = decodeRows(row)
  return (rows: ReadonlyArray<Record<string, unknown>>) =>
    decode(
      rows.filter(
        ({ stock_code: code, holder_key: key }) =>
          (code === undefined || isStockCode(code)) &&
          (key === undefined || isHolderKey(key))
      )
    )
}

// A name's holder key, or none for a name that keys blank (legal-form
// words only): no holder is matched by it.
export const nameKey = (name: string) =>
  Effect.map(holderKey(name), (key) => (isHolderKey(key) ? key : undefined))
