// The stock page's reads from parsed holdings (spec apinrdw/kumora#363,
// "Stock page read model"): everything /stocks/$CODE shows for a code, and
// the list of stocks its picker offers.
import { Effect, Schema } from "effect"
import { StockCode } from "@workspace/relay"

import {
  CLASSIFICATIONS,
  type Classification,
  KSEI_TYPES,
  type KseiType,
} from "@/domain/holdings"

import { HoldingsDb } from "./db.ts"

// Shares held, by origin. `local` and `foreign` are absent in a month whose
// report doesn't split them, never 0.
export interface OriginShares {
  readonly combined: number
  readonly local?: number | undefined
  readonly foreign?: number | undefined
}

export interface ClassificationShares extends OriginShares {
  readonly classification: Classification
}

// A KSEI investor type's shares: the sum of its classifications' (the owner's
// 39 → 9 mapping). Only classifications holding shares are listed.
export interface TypeShares extends OriginShares {
  readonly type: KseiType
  readonly classifications: ReadonlyArray<ClassificationShares>
}

// A stock's month in the classification report.
export interface CompositionMonth {
  readonly dataDate: string
  readonly totalScripless: number
  // KSEI's `Sec. Num` for the stock on the same date; undefined when KSEI has
  // no file of that date, or no row for the stock in it.
  readonly listedShares: number | undefined
  // Whether the report splits local and foreign (Sep 2026 onward).
  readonly split: boolean
  // All 9 types, in KSEI_TYPES order, zeros included.
  readonly types: ReadonlyArray<TypeShares>
}

export interface StockPage {
  readonly code: StockCode
  // As the newest classification report holding the stock prints it.
  readonly issuerName: string | undefined
  // Every parsed classification month, oldest first, and whether the stock
  // has a row in it.
  readonly months: ReadonlyArray<{
    readonly dataDate: string
    readonly held: boolean
  }>
  // Whether any parsed KSEI file has the stock. A stock KSEI has and no
  // classification report does (unpriced or suspended) has no composition.
  readonly inKsei: boolean
  // The selected month and the parsed month before it, when the stock has a
  // row there; undefined when no classification report has the stock.
  readonly composition:
    | {
        readonly month: CompositionMonth
        readonly previous: CompositionMonth | undefined
      }
    | undefined
}

const MonthRow = Schema.Struct({
  data_date: Schema.String,
  issuer_name: Schema.NullOr(Schema.String),
  total_scripless: Schema.NullOr(Schema.Number),
  listed_shares: Schema.NullOr(Schema.Number),
})
const HoldingRow = Schema.Struct({
  data_date: Schema.String,
  classification: Schema.Literals(
    Object.keys(CLASSIFICATIONS) as ReadonlyArray<Classification>
  ),
  origin: Schema.Literals(["local", "foreign", "combined"]),
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
  SELECT m.data_date, s.issuer_name, s.total_scripless, k.listed_shares
  FROM classification_month m
  LEFT JOIN classification_stock_month s
    ON s.data_date = m.data_date AND s.stock_code = ?1
  LEFT JOIN ksei_stock_month k
    ON k.period_end = m.data_date AND k.stock_code = ?1
  ORDER BY m.data_date`

const IN_KSEI = `
  SELECT EXISTS(SELECT 1 FROM ksei_stock_month WHERE stock_code = ?1) AS held`

const addShares = (
  into: OriginShares,
  { combined, local, foreign }: OriginShares
): OriginShares => ({
  combined: into.combined + combined,
  local: into.local === undefined ? undefined : into.local + (local ?? 0),
  foreign:
    into.foreign === undefined ? undefined : into.foreign + (foreign ?? 0),
})

const compositionMonth = (
  dataDate: string,
  totalScripless: number,
  listedShares: number | undefined,
  rows: ReadonlyArray<HoldingRow>
): CompositionMonth => {
  const split = rows.some(({ origin }) => origin !== "combined")
  const empty: OriginShares = split
    ? { combined: 0, local: 0, foreign: 0 }
    : { combined: 0 }
  const byClassification = new Map<Classification, OriginShares>()
  for (const { classification, origin, shares } of rows) {
    const held = byClassification.get(classification) ?? empty
    byClassification.set(classification, { ...held, [origin]: shares })
  }
  const types = KSEI_TYPES.map((type): TypeShares => {
    const classifications = [...byClassification]
      .filter(
        ([classification]) => CLASSIFICATIONS[classification].type === type
      )
      .map(([classification, held]) => ({ classification, ...held }))
    return {
      type,
      ...classifications.reduce(addShares, empty),
      classifications,
    }
  })
  return { dataDate, totalScripless, listedShares, split, types }
}

// Everything the stock page shows for a code. `month` is the URL's
// `YYYY-MM`; a month the stock has no row in falls back to its newest.
// Decision: one batch, so each month reads whole while the archive run
// replaces it (apinrdw/kumora#355).
export const stockPage = Effect.fnUntraced(function* (
  code: StockCode,
  month: string | undefined
) {
  const [monthRows = [], holdingRows = [], kseiRows = []] =
    yield* (yield* HoldingsDb).batch([
      { sql: MONTHS, params: [code] },
      { sql: HOLDINGS, params: [code, month ?? null] },
      { sql: IN_KSEI, params: [code] },
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
      row.total_scripless,
      row.listed_shares ?? undefined,
      holdings.filter(({ data_date }) => data_date === row.data_date)
    )
  const [inKsei] = Schema.decodeUnknownSync(
    Schema.Tuple([Schema.Struct({ held: Schema.Number })])
  )(kseiRows)
  const previous = held.find(({ data_date }) => data_date === before?.data_date)
  return {
    code,
    issuerName: held.at(-1)?.issuer_name ?? undefined,
    inKsei: inKsei.held === 1,
    months: months.map(({ data_date, total_scripless }) => ({
      dataDate: data_date,
      held: total_scripless !== null,
    })),
    composition:
      selected === undefined
        ? undefined
        : {
            month: read(selected),
            previous: previous === undefined ? undefined : read(previous),
          },
  } satisfies StockPage
})

const ListRow = Schema.Struct({
  stock_code: Schema.String,
  issuer_name: Schema.NullOr(Schema.String),
})

const isStockCode = Schema.is(StockCode)

// The stocks the page's picker offers: those in the newest month of either
// source, by code, with the classification report's issuer name. KSEI's
// file names no issuer. A KSEI code that isn't a stock code's shape is left
// out, as no page could open it.
export const stockList = Effect.gen(function* () {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: `WITH classified AS (
          SELECT stock_code, issuer_name FROM classification_stock_month
          WHERE data_date = (SELECT MAX(data_date) FROM classification_month)
        )
        SELECT stock_code, issuer_name FROM classified
        UNION
        SELECT stock_code, NULL FROM ksei_stock_month
        WHERE period_end = (SELECT MAX(period_end) FROM ksei_month)
          AND stock_code NOT IN (SELECT stock_code FROM classified)
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
