// The stock page's reads from parsed holdings (spec apinrdw/kumora#363,
// "Stock page read model"): everything /stocks/$CODE shows for a code, and
// the list of stocks its picker offers.
import { Effect, Schema } from "effect"
import { StockCode } from "@workspace/relay"

import {
  CLASSIFICATIONS,
  Classification,
  Controller,
  KSEI_TYPES,
  KseiType,
  Origin,
  SplitOrigin,
} from "@/domain/holdings"

import { HoldingsDb } from "./db.ts"
import { DAILY_WINDOW, MONTHLY_WINDOW, readFrom } from "./holders-window.ts"

// Shares held, by origin. `local` and `foreign` are absent in a month whose
// report doesn't split them, never 0.
const ORIGIN_SHARES = {
  combined: Schema.Number,
  local: Schema.optional(Schema.Number),
  foreign: Schema.optional(Schema.Number),
}
type OriginShares = Schema.Struct.Type<typeof ORIGIN_SHARES>

const ClassificationShares = Schema.Struct({
  classification: Classification,
  ...ORIGIN_SHARES,
})

// A KSEI investor type's shares: the sum of its classifications' (the owner's
// 39 → 9 mapping). Only classifications holding shares are listed.
const TypeShares = Schema.Struct({
  type: KseiType,
  ...ORIGIN_SHARES,
  classifications: Schema.Array(ClassificationShares),
})
type TypeShares = typeof TypeShares.Type

// A stock's month in the classification report.
const CompositionMonth = Schema.Struct({
  dataDate: Schema.String,
  totalScripless: Schema.Number,
  // KSEI's `Sec. Num` for the stock on the same date; undefined when KSEI has
  // no Securities holdings report of that date, or no row for the stock in it.
  listedShares: Schema.UndefinedOr(Schema.Number),
  // Whether the report splits local and foreign (Sep 2026 onward).
  split: Schema.Boolean,
  // All 9 types, in KSEI_TYPES order, zeros included.
  types: Schema.Array(TypeShares),
})
export type CompositionMonth = typeof CompositionMonth.Type

// Shares each KSEI investor type holds, 0 for a type holding none.
const TypeHoldings = Schema.Record(KseiType, Schema.Number)
export type TypeHoldings = typeof TypeHoldings.Type

// A month of the KSEI series. `holdings` is undefined for a month whose
// report has no row for the stock, or that no parsed report covers: a gap.
const SeriesMonth = Schema.Struct({
  // `YYYY-MM`.
  month: Schema.String,
  holdings: Schema.UndefinedOr(
    Schema.Struct({
      periodEnd: Schema.String,
      local: TypeHoldings,
      foreign: TypeHoldings,
    })
  ),
})
export type SeriesMonth = typeof SeriesMonth.Type

// An investor type's scripless shares with <5% and with ≥5% holders.
const InvestorTypeHolding = Schema.Struct({
  under5: Schema.Number,
  atLeast5: Schema.Number,
})
export type InvestorTypeHolding = typeof InvestorTypeHolding.Type

// Each of the 9 KSEI investor types' investor-type holdings, 0 in both
// for a type holding none.
const InvestorTypeHoldings = Schema.Record(KseiType, InvestorTypeHolding)
export type InvestorTypeHoldings = typeof InvestorTypeHoldings.Type

// An investor-type report month. `holding` is undefined when the report has
// no row for the stock.
const HolderSizeMonth = Schema.Struct({
  dataDate: Schema.String,
  // Whether the report splits local and foreign (Jan 2026 onward).
  split: Schema.Boolean,
  holding: Schema.UndefinedOr(
    Schema.Struct({
      sharesOutstanding: Schema.Number,
      totalScripless: Schema.Number,
      combined: InvestorTypeHoldings,
      // Absent in a month that doesn't split, never 0.
      local: Schema.optional(InvestorTypeHoldings),
      foreign: Schema.optional(InvestorTypeHoldings),
    })
  ),
})
export type HolderSizeMonth = typeof HolderSizeMonth.Type

// One row of an above-1% report as published. `percentageHundredths` is
// its % of listed shares × 100.
const Above1HolderRow = Schema.Struct({
  name: Schema.String,
  // Undefined in Feb–Mar 2026, which publish a type instead, or when blank.
  classification: Schema.UndefinedOr(Classification),
  type: Schema.UndefinedOr(KseiType),
  // Undefined for a special scrip account.
  origin: Schema.UndefinedOr(SplitOrigin),
  domicile: Schema.UndefinedOr(Schema.String),
  controller: Schema.UndefinedOr(Controller),
  total: Schema.Number,
  percentageHundredths: Schema.Number,
})

// A ≥1% holder: a month's rows of the stock sharing a holder key, summed,
// its rows in file order.
const Above1Holder = Schema.Struct({
  key: Schema.String,
  scripless: Schema.Number,
  scrip: Schema.Number,
  total: Schema.Number,
  percentageHundredths: Schema.Number,
  rows: Schema.Array(Above1HolderRow),
})
export type Above1Holder = typeof Above1Holder.Type

// An above-1% report month, its holders in the order of their first row;
// none when the report has no row for the stock.
const MajorHoldersMonth = Schema.Struct({
  dataDate: Schema.String,
  holders: Schema.Array(Above1Holder),
})
export type MajorHoldersMonth = typeof MajorHoldersMonth.Type

// One securities account of an above-5% holder's block as published.
const Above5SecuritiesAccount = Schema.Struct({
  // The broker or bank holding the account.
  custodian: Schema.String,
  name: Schema.String,
  origin: SplitOrigin,
  domicile: Schema.UndefinedOr(Schema.String),
  // 0 for an account the report lists emptied that day.
  scripless: Schema.Number,
})
export type Above5SecuritiesAccount = typeof Above5SecuritiesAccount.Type

// One block of the daily above-5% report as published: repeat blocks of one
// investor are each their own, collapsed by the Daily holders view model.
const Above5Holder = Schema.Struct({
  name: Schema.String,
  key: Schema.String,
  scripless: Schema.Number,
  percentageHundredths: Schema.Number,
  // In the block's order.
  accounts: Schema.Array(Above5SecuritiesAccount),
})
export type Above5Holder = typeof Above5Holder.Type

// A parsed above-5% day: the stock's blocks in report order, none when no
// holder of it is above 5% that day, and its listed shares then.
const DailyHoldersDay = Schema.Struct({
  dataDate: Schema.String,
  // The newest parsed investor-type report's on or before the day;
  // undefined when none lists the stock.
  listedShares: Schema.UndefinedOr(Schema.Number),
  holders: Schema.Array(Above5Holder),
})
export type DailyHoldersDay = typeof DailyHoldersDay.Type

const StockPage = Schema.Struct({
  code: StockCode,
  // As the newest classification report holding the stock prints it, else
  // the newest above-5% report holding it.
  issuerName: Schema.UndefinedOr(Schema.String),
  // Every parsed classification month, oldest first, and whether the stock
  // has a row in it.
  months: Schema.Array(
    Schema.Struct({ dataDate: Schema.String, held: Schema.Boolean })
  ),
  // Whether any parsed KSEI report has the stock. A stock KSEI has and no
  // classification report does (unpriced or suspended) has no composition.
  inKsei: Schema.Boolean,
  // The selected month and the parsed month before it, when the stock has a
  // row there; undefined when no classification report has the stock.
  composition: Schema.UndefinedOr(
    Schema.Struct({
      month: CompositionMonth,
      previous: Schema.UndefinedOr(CompositionMonth),
    })
  ),
  // KSEI's holdings of the stock, one entry per month from its first period
  // end to its last, oldest first.
  series: Schema.Array(SeriesMonth),
  // Every parsed investor-type month, oldest first, with the stock's
  // holdings where it has a row.
  holderSize: Schema.Array(HolderSizeMonth),
  // The newest parsed above-1% months that fit MONTHLY_WINDOW's budget,
  // oldest first, with the stock's ≥1% holders.
  majorHolders: Schema.Array(MajorHoldersMonth),
  // The newest parsed above-5% days that fit DAILY_WINDOW's budget, oldest
  // first, with the stock's above-5% holders.
  dailyHolders: Schema.Array(DailyHoldersDay),
})
export type StockPage = typeof StockPage.Type

const MonthRow = Schema.Struct({
  data_date: Schema.String,
  split: Schema.BooleanFromBit,
  issuer_name: Schema.NullOr(Schema.String),
  total_scripless: Schema.NullOr(Schema.Number),
  listed_shares: Schema.NullOr(Schema.Number),
})
const HoldingRow = Schema.Struct({
  data_date: Schema.String,
  classification: Classification,
  origin: Origin,
  shares: Schema.Number,
})
type HoldingRow = typeof HoldingRow.Type

// The months holding the stock, the requested one if it is among them; else
// the newest of them. ?1 is the code, ?2 the requested `YYYY-MM`.
const SELECTED = `
  SELECT COALESCE(
    (SELECT m.data_date FROM classification_month m
      JOIN classification_stock_month s
        ON s.data_date = m.data_date AND s.stock_code = ?1
      WHERE substr(m.data_date, 1, 7) = ?2),
    (SELECT MAX(m.data_date) FROM classification_month m
      JOIN classification_stock_month s
        ON s.data_date = m.data_date AND s.stock_code = ?1)
  )`

// The selected month's and the month before it's holdings of the stock.
const HOLDINGS = `
  WITH selected(data_date) AS (${SELECTED}),
  previous(data_date) AS (
    SELECT MAX(data_date) FROM classification_month
    WHERE data_date < (SELECT data_date FROM selected)
  )
  SELECT data_date, classification, origin, shares
  FROM classification_holding
  WHERE stock_code = ?1 AND data_date IN (
    SELECT data_date FROM selected UNION ALL SELECT data_date FROM previous
  )`

const MONTHS = `
  SELECT m.data_date, m.split, s.issuer_name, s.total_scripless, k.listed_shares
  FROM classification_month m
  LEFT JOIN classification_stock_month s
    ON s.data_date = m.data_date AND s.stock_code = ?1
  LEFT JOIN ksei_stock_month k
    ON k.period_end = m.data_date AND k.stock_code = ?1
  ORDER BY m.data_date`

// The stock's KSEI period ends, and its holdings in each. ?1 is the code.
const SERIES_MONTHS = `
  SELECT period_end FROM ksei_stock_month WHERE stock_code = ?1
  ORDER BY period_end`
const SERIES_HOLDINGS = `
  SELECT period_end, origin, investor_type, shares FROM ksei_holding
  WHERE stock_code = ?1`

const SeriesMonthRow = Schema.Struct({ period_end: Schema.String })
const SeriesHoldingRow = Schema.Struct({
  period_end: Schema.String,
  origin: SplitOrigin,
  investor_type: KseiType,
  shares: Schema.Number,
})

// The stock's investor-type months and its holdings in each. ?1 is the code.
const HOLDER_SIZE_MONTHS = `
  SELECT m.data_date, m.split, s.shares_outstanding, s.total_scripless
  FROM investor_type_month m
  LEFT JOIN investor_type_stock_month s
    ON s.data_date = m.data_date AND s.stock_code = ?1
  ORDER BY m.data_date`
const HOLDER_SIZE_HOLDINGS = `
  SELECT data_date, origin, investor_type, under_5, at_least_5
  FROM investor_type_holding WHERE stock_code = ?1`

const HolderSizeMonthRow = Schema.Struct({
  data_date: Schema.String,
  split: Schema.BooleanFromBit,
  shares_outstanding: Schema.NullOr(Schema.Number),
  total_scripless: Schema.NullOr(Schema.Number),
})
const HolderSizeHoldingRow = Schema.Struct({
  data_date: Schema.String,
  origin: Origin,
  investor_type: KseiType,
  under_5: Schema.Number,
  at_least_5: Schema.Number,
})

type HolderSizeHoldingRow = typeof HolderSizeHoldingRow.Type

// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
//
// The stock's newest parsed periods of a kind whose rows fit its budget, as
// the CTE `read_from`'s `since`. ?1 is the code.
const ABOVE_1_READ = `WITH ${readFrom(MONTHLY_WINDOW, "SELECT ?1 AS stock_code")}`
const ABOVE_5_READ = `WITH ${readFrom(DAILY_WINDOW, "SELECT ?1 AS stock_code")}`
const SINCE = `(SELECT since FROM read_from)`

// Those above-1% months, and the stock's rows in each in file order.
const ABOVE_1_MONTHS = `${ABOVE_1_READ}
  SELECT data_date FROM above_1_month WHERE data_date >= ${SINCE}
  ORDER BY data_date`
const ABOVE_1_HOLDINGS = `${ABOVE_1_READ}
  SELECT data_date, holder_key, investor_name, classification,
    investor_type, origin, domicile, controller, scripless, scrip, total,
    percentage_hundredths
  FROM above_1_holding WHERE stock_code = ?1 AND data_date >= ${SINCE}
  ORDER BY data_date, seq`

const Above1MonthRow = Schema.Struct({ data_date: Schema.String })
export const Above1HoldingRow = Schema.Struct({
  data_date: Schema.String,
  holder_key: Schema.String,
  investor_name: Schema.String,
  classification: Schema.NullOr(Classification),
  investor_type: Schema.NullOr(KseiType),
  origin: Schema.NullOr(SplitOrigin),
  domicile: Schema.NullOr(Schema.String),
  controller: Schema.NullOr(Controller),
  scripless: Schema.Number,
  scrip: Schema.Number,
  total: Schema.Number,
  percentage_hundredths: Schema.Number,
})

export type Above1HoldingRow = typeof Above1HoldingRow.Type

// A stored row as the report published it.
const publishedRow = (row: Above1HoldingRow) =>
  Effect.succeed<Above1Holder["rows"][number]>({
    name: row.investor_name,
    classification: row.classification ?? undefined,
    type: row.investor_type ?? undefined,
    origin: row.origin ?? undefined,
    domicile: row.domicile ?? undefined,
    controller: row.controller ?? undefined,
    total: row.total,
    percentageHundredths: row.percentage_hundredths,
  })

// Each above-1% month's rows grouped into holders by holder key.
export const above1Months = Effect.fnUntraced(function* (
  monthRows: ReadonlyArray<typeof Above1MonthRow.Type>,
  holdingRows: ReadonlyArray<Above1HoldingRow>
) {
  const byMonth = new Map<string, Map<string, Above1Holder>>(
    monthRows.map(({ data_date }) => [data_date, new Map()])
  )
  for (const row of holdingRows) {
    const holders = byMonth.get(row.data_date)
    if (holders === undefined) continue
    const held = holders.get(row.holder_key) ?? {
      key: row.holder_key,
      scripless: 0,
      scrip: 0,
      total: 0,
      percentageHundredths: 0,
      rows: [],
    }
    holders.set(row.holder_key, {
      key: row.holder_key,
      scripless: held.scripless + row.scripless,
      scrip: held.scrip + row.scrip,
      total: held.total + row.total,
      percentageHundredths:
        held.percentageHundredths + row.percentage_hundredths,
      rows: [...held.rows, yield* publishedRow(row)],
    })
  }
  return [...byMonth].map(([dataDate, holders]): MajorHoldersMonth => ({
    dataDate,
    holders: [...holders.values()],
  }))
})

// Those above-5% days, the stock's listed shares on each, and its blocks
// and accounts in report order.
const ABOVE_5_DAYS = `${ABOVE_5_READ}
  SELECT d.data_date, (
    SELECT s.shares_outstanding FROM investor_type_stock_month s
    WHERE s.stock_code = ?1 AND s.data_date <= d.data_date
    ORDER BY s.data_date DESC LIMIT 1
  ) AS listed_shares
  FROM above_5_day d WHERE d.data_date >= ${SINCE} ORDER BY d.data_date`
const ABOVE_5_HOLDERS = `${ABOVE_5_READ}
  SELECT data_date, no, issuer_name, holder_name, holder_key, scripless,
    percentage_hundredths
  FROM above_5_holder
  WHERE stock_code = ?1 AND data_date >= ${SINCE}
  ORDER BY data_date, no`
const ABOVE_5_ACCOUNTS = `${ABOVE_5_READ}
  SELECT data_date, no, custodian, account_name, origin, domicile, scripless
  FROM above_5_account
  WHERE stock_code = ?1 AND data_date >= ${SINCE}
  ORDER BY data_date, no, ordinal`

const Above5DayRow = Schema.Struct({
  data_date: Schema.String,
  listed_shares: Schema.NullOr(Schema.Number),
})
export const Above5HolderRow = Schema.Struct({
  data_date: Schema.String,
  no: Schema.Number,
  issuer_name: Schema.String,
  holder_name: Schema.String,
  holder_key: Schema.String,
  scripless: Schema.Number,
  percentage_hundredths: Schema.Number,
})
export const Above5SecuritiesAccountRow = Schema.Struct({
  data_date: Schema.String,
  no: Schema.Number,
  custodian: Schema.String,
  account_name: Schema.String,
  origin: SplitOrigin,
  domicile: Schema.NullOr(Schema.String),
  scripless: Schema.Number,
})

// Each of `dayRows`' days with the stock's blocks, each with its accounts;
// none on a day without a block.
export const above5Days = (
  dayRows: ReadonlyArray<typeof Above5DayRow.Type>,
  holderRows: ReadonlyArray<typeof Above5HolderRow.Type>,
  accountRows: ReadonlyArray<typeof Above5SecuritiesAccountRow.Type>
) =>
  Effect.sync(() => {
    const accounts = new Map<string, Array<Above5SecuritiesAccount>>()
    for (const row of accountRows) {
      const block = `${row.data_date} ${row.no}`
      accounts.set(block, [
        ...(accounts.get(block) ?? []),
        {
          custodian: row.custodian,
          name: row.account_name,
          origin: row.origin,
          domicile: row.domicile ?? undefined,
          scripless: row.scripless,
        },
      ])
    }
    const holders = new Map<string, Array<Above5Holder>>()
    for (const row of holderRows)
      holders.set(row.data_date, [
        ...(holders.get(row.data_date) ?? []),
        {
          name: row.holder_name,
          key: row.holder_key,
          scripless: row.scripless,
          percentageHundredths: row.percentage_hundredths,
          accounts: accounts.get(`${row.data_date} ${row.no}`) ?? [],
        },
      ])
    return dayRows.map(({ data_date, listed_shares }): DailyHoldersDay => ({
      dataDate: data_date,
      listedShares: listed_shares ?? undefined,
      holders: holders.get(data_date) ?? [],
    }))
  })

// A new record of each of the 9 KSEI investor types holding `none`.
const noneOfEachType = <A>(none: A) =>
  Effect.sync(
    () =>
      Object.fromEntries(KSEI_TYPES.map((type) => [type, none])) as Record<
        KseiType,
        A
      >
  )

// A month's investor-type holdings of one origin, 0/0 for a type with no
// row.
const investorTypeHoldings = Effect.fnUntraced(function* (
  holdingRows: ReadonlyArray<HolderSizeHoldingRow>,
  dataDate: string,
  origin: Origin
) {
  const holdings = yield* noneOfEachType<InvestorTypeHolding>({
    under5: 0,
    atLeast5: 0,
  })
  for (const held of holdingRows)
    if (held.data_date === dataDate && held.origin === origin)
      holdings[held.investor_type] = {
        under5: held.under_5,
        atLeast5: held.at_least_5,
      }
  return holdings
})

const holderSizeMonth = Effect.fnUntraced(function* (
  row: typeof HolderSizeMonthRow.Type,
  holdingRows: ReadonlyArray<HolderSizeHoldingRow>
) {
  const { data_date: dataDate, split } = row
  if (row.shares_outstanding === null || row.total_scripless === null)
    return { dataDate, split, holding: undefined } satisfies HolderSizeMonth
  return {
    dataDate,
    split,
    holding: {
      sharesOutstanding: row.shares_outstanding,
      totalScripless: row.total_scripless,
      combined: yield* investorTypeHoldings(holdingRows, dataDate, "combined"),
      ...(split && {
        local: yield* investorTypeHoldings(holdingRows, dataDate, "local"),
        foreign: yield* investorTypeHoldings(holdingRows, dataDate, "foreign"),
      }),
    },
  } satisfies HolderSizeMonth
})

const holderSize = (
  monthRows: ReadonlyArray<typeof HolderSizeMonthRow.Type>,
  holdingRows: ReadonlyArray<HolderSizeHoldingRow>
) => Effect.forEach(monthRows, (row) => holderSizeMonth(row, holdingRows))

/** `2026-12` → `2027-01` */
const nextMonth = (month: string) =>
  Effect.sync(() => {
    const year = Number(month.slice(0, 4))
    const index = Number(month.slice(5, 7))
    return index === 12
      ? `${year + 1}-01`
      : `${year}-${String(index + 1).padStart(2, "0")}`
  })

const kseiSeries = Effect.fnUntraced(function* (
  monthRows: ReadonlyArray<typeof SeriesMonthRow.Type>,
  holdingRows: ReadonlyArray<typeof SeriesHoldingRow.Type>
) {
  const byMonth = new Map<
    string,
    {
      periodEnd: string
      local: Record<KseiType, number>
      foreign: Record<KseiType, number>
    }
  >()
  for (const { period_end } of monthRows)
    byMonth.set(period_end.slice(0, 7), {
      periodEnd: period_end,
      local: yield* noneOfEachType(0),
      foreign: yield* noneOfEachType(0),
    })
  for (const { period_end, origin, investor_type, shares } of holdingRows) {
    const held = byMonth.get(period_end.slice(0, 7))
    if (held !== undefined) held[origin][investor_type] = shares
  }
  const first = monthRows.at(0)?.period_end.slice(0, 7)
  const last = monthRows.at(-1)?.period_end.slice(0, 7)
  if (first === undefined || last === undefined) return []
  const months: Array<SeriesMonth> = []
  for (let month = first; month <= last; month = yield* nextMonth(month))
    months.push({ month, holdings: byMonth.get(month) })
  return months
})

const addShares = (
  into: OriginShares,
  { combined, local, foreign }: OriginShares
) =>
  Effect.succeed<OriginShares>({
    combined: into.combined + combined,
    local: into.local === undefined ? undefined : into.local + (local ?? 0),
    foreign:
      into.foreign === undefined ? undefined : into.foreign + (foreign ?? 0),
  })

const compositionMonth = Effect.fnUntraced(function* (
  dataDate: string,
  split: boolean,
  totalScripless: number,
  listedShares: number | undefined,
  rows: ReadonlyArray<HoldingRow>
) {
  const empty: OriginShares = split
    ? { combined: 0, local: 0, foreign: 0 }
    : { combined: 0 }
  const byClassification = new Map<Classification, OriginShares>()
  for (const { classification, origin, shares } of rows) {
    const held = byClassification.get(classification) ?? empty
    byClassification.set(classification, { ...held, [origin]: shares })
  }
  const types: Array<TypeShares> = []
  for (const type of KSEI_TYPES) {
    const classifications = [...byClassification]
      .filter(
        ([classification]) => CLASSIFICATIONS[classification].type === type
      )
      .map(([classification, held]) => ({ classification, ...held }))
    let sum = empty
    for (const held of classifications) sum = yield* addShares(sum, held)
    types.push({ type, ...sum, classifications })
  }
  return CompositionMonth.make({
    dataDate,
    totalScripless,
    listedShares,
    split,
    types,
  })
})

// Everything the stock page shows for a code. `month` is the URL's
// `YYYY-MM`; a month the stock has no row in falls back to its newest.
// One batch, so each month reads whole while a parse run replaces
// it (apinrdw/kumora#355, #402).
export const stockPage = Effect.fnUntraced(function* (
  code: StockCode,
  month: string | undefined
) {
  const [
    monthRows = [],
    holdingRows = [],
    seriesMonthRows = [],
    seriesHoldingRows = [],
    holderSizeMonthRows = [],
    holderSizeHoldingRows = [],
    above1MonthRows = [],
    above1HoldingRows = [],
    above5DayRows = [],
    above5HolderRows = [],
    above5AccountRows = [],
  ] = yield* (yield* HoldingsDb).batch([
    { sql: MONTHS, params: [code] },
    { sql: HOLDINGS, params: [code, month ?? null] },
    { sql: SERIES_MONTHS, params: [code] },
    { sql: SERIES_HOLDINGS, params: [code] },
    { sql: HOLDER_SIZE_MONTHS, params: [code] },
    { sql: HOLDER_SIZE_HOLDINGS, params: [code] },
    { sql: ABOVE_1_MONTHS, params: [code] },
    { sql: ABOVE_1_HOLDINGS, params: [code] },
    { sql: ABOVE_5_DAYS, params: [code] },
    { sql: ABOVE_5_HOLDERS, params: [code] },
    { sql: ABOVE_5_ACCOUNTS, params: [code] },
  ])
  const above5Holders = Schema.decodeUnknownSync(Schema.Array(Above5HolderRow))(
    above5HolderRows
  )
  const months = Schema.decodeUnknownSync(Schema.Array(MonthRow))(monthRows)
  const holdings = Schema.decodeUnknownSync(Schema.Array(HoldingRow))(
    holdingRows
  )
  const held = months.filter(
    (row): row is typeof row & { readonly total_scripless: number } =>
      row.total_scripless !== null
  )
  const selected =
    held.find(({ data_date }) => data_date.slice(0, 7) === month) ?? held.at(-1)
  const before = months
    .filter(
      ({ data_date }) =>
        selected !== undefined && data_date < selected.data_date
    )
    .at(-1)
  const read = (row: (typeof held)[number]) =>
    compositionMonth(
      row.data_date,
      row.split,
      row.total_scripless,
      row.listed_shares ?? undefined,
      holdings.filter(({ data_date }) => data_date === row.data_date)
    )
  const previous = held.find(({ data_date }) => data_date === before?.data_date)
  const series = yield* kseiSeries(
    Schema.decodeUnknownSync(Schema.Array(SeriesMonthRow))(seriesMonthRows),
    Schema.decodeUnknownSync(Schema.Array(SeriesHoldingRow))(seriesHoldingRows)
  )
  return StockPage.make({
    code,
    issuerName: held.at(-1)?.issuer_name ?? above5Holders.at(-1)?.issuer_name,
    // The series is empty only when no KSEI report has the stock.
    inKsei: series.length > 0,
    months: months.map(({ data_date, total_scripless }) => ({
      dataDate: data_date,
      held: total_scripless !== null,
    })),
    composition:
      selected === undefined
        ? undefined
        : {
            month: yield* read(selected),
            previous:
              previous === undefined ? undefined : yield* read(previous),
          },
    series,
    holderSize: yield* holderSize(
      Schema.decodeUnknownSync(Schema.Array(HolderSizeMonthRow))(
        holderSizeMonthRows
      ),
      Schema.decodeUnknownSync(Schema.Array(HolderSizeHoldingRow))(
        holderSizeHoldingRows
      )
    ),
    majorHolders: yield* above1Months(
      Schema.decodeUnknownSync(Schema.Array(Above1MonthRow))(above1MonthRows),
      Schema.decodeUnknownSync(Schema.Array(Above1HoldingRow))(
        above1HoldingRows
      )
    ),
    dailyHolders: yield* above5Days(
      Schema.decodeUnknownSync(Schema.Array(Above5DayRow))(above5DayRows),
      above5Holders,
      Schema.decodeUnknownSync(Schema.Array(Above5SecuritiesAccountRow))(
        above5AccountRows
      )
    ),
  })
})

const ListRow = Schema.Struct({
  stock_code: Schema.String,
  issuer_name: Schema.NullOr(Schema.String),
})

const isStockCode = Schema.is(StockCode)

// The stocks the page's picker offers: those in the newest month of KSEI's
// report, the classification report or the investor-type report, by code,
// with the classification report's issuer name. KSEI's and the investor-type report
// name no issuer. A code that isn't a stock code's shape is left out.
// No above-1% source here. In IDX's data every above-1% stock is in
// the investor-type report (spec apinrdw/kumora#479); one only above-1% has
// opens by URL until its investor-type parse lands.
export const stockList = Effect.gen(function* () {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: `WITH classified AS (
          SELECT stock_code, issuer_name FROM classification_stock_month
          WHERE data_date = (SELECT MAX(data_date) FROM classification_month)
        )
        SELECT stock_code, issuer_name FROM classified
        UNION
        SELECT stock_code, NULL FROM (
          SELECT stock_code FROM ksei_stock_month
          WHERE period_end = (SELECT MAX(period_end) FROM ksei_month)
          UNION
          SELECT stock_code FROM investor_type_stock_month
          WHERE data_date = (SELECT MAX(data_date) FROM investor_type_month)
        )
        WHERE stock_code NOT IN (SELECT stock_code FROM classified)
        ORDER BY stock_code`,
      params: [],
    },
  ])
  return Schema.decodeUnknownSync(Schema.Array(ListRow))(rows).flatMap(
    ({ stock_code, issuer_name }) =>
      isStockCode(stock_code)
        ? [{ code: stock_code, issuerName: issuer_name ?? undefined }]
        : []
  )
})
