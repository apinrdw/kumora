// The stock page's reads from parsed holdings (spec apinrdw/kumora#363,
// "Stock page read model"): everything /stocks/$CODE shows for a code, and
// the list of stocks its picker offers.
import { Effect, Schema } from "effect"
import { StockCode } from "@workspace/relay"

import {
  CLASSIFICATIONS,
  Classification,
  KSEI_TYPES,
  KseiType,
  Origin,
  SplitOrigin,
} from "@/domain/holdings"

import { HoldingsDb } from "./db.ts"

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

const StockPage = Schema.Struct({
  code: StockCode,
  // As the newest classification report holding the stock prints it.
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

// A month's investor-type holdings of one origin, 0/0 for a type with no
// row.
const investorTypeHoldings = (
  holdingRows: ReadonlyArray<HolderSizeHoldingRow>,
  dataDate: string,
  origin: Origin
) =>
  Effect.sync(() => {
    const holdings = Object.fromEntries(
      KSEI_TYPES.map((type) => [type, { under5: 0, atLeast5: 0 }])
    ) as Record<KseiType, InvestorTypeHolding>
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

const noHoldings = Effect.sync(
  () =>
    Object.fromEntries(KSEI_TYPES.map((type) => [type, 0])) as Record<
      KseiType,
      number
    >
)

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
      local: yield* noHoldings,
      foreign: yield* noHoldings,
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
// Decision: one batch, so each month reads whole while a parse run replaces
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
  ] = yield* (yield* HoldingsDb).batch([
    { sql: MONTHS, params: [code] },
    { sql: HOLDINGS, params: [code, month ?? null] },
    { sql: SERIES_MONTHS, params: [code] },
    { sql: SERIES_HOLDINGS, params: [code] },
    { sql: HOLDER_SIZE_MONTHS, params: [code] },
    { sql: HOLDER_SIZE_HOLDINGS, params: [code] },
  ])
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
    issuerName: held.at(-1)?.issuer_name ?? undefined,
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
  })
})

const ListRow = Schema.Struct({
  stock_code: Schema.String,
  issuer_name: Schema.NullOr(Schema.String),
})

const isStockCode = Schema.is(StockCode)

// The stocks the page's picker offers: those in the newest month of any
// source, by code, with the classification report's issuer name. KSEI's and
// the investor-type report name no issuer. A code that isn't a stock code's
// shape is left out, as no page could open it.
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
