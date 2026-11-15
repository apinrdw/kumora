// IDX's month-end "holdings by investor classification" report, parsed into
// parsed holdings (holdings-migrations/0001_classification.sql) and read
// back a stock-month at a time. Spec apinrdw/kumora#363, "Reading the IDX
// classification xlsx".
import { Effect, Schema } from "effect"

import { HoldingsDb, type SqlValue } from "./db.ts"
import { replaceMonth } from "./month-replace.ts"
import { type Cell, readSheet } from "./xlsx.ts"

// Bumped whenever parsing changes what it stores: the archive run's
// reconcile then parses every month again.
export const PARSER_VERSION = 1

// The 39 investor classifications, by the slug parsed holdings store, with
// their header label as both layouts print it, once lowercased and with any
// `Local_`/`Foreign_` prefix dropped.
const CLASSIFICATIONS = {
  bank: "bank",
  government: "government",
  private_equity: "private equity",
  trustee_bank: "trustee bank",
  venture_capital: "venture capital",
  private_bank: "private bank",
  exchange_traded_funds: "exchange traded funds",
  investment_manager: "investment manager",
  investment_advisors: "investment advisors",
  brokerage_firms: "brokerage firms",
  hedge_fund: "hedge fund",
  sovereign_wealth_fund: "sovereign wealth fund",
  capital_market_supporting:
    "capital market supporting institutions and professions",
  cv_limited_partnership:
    "commanditaire vennootschap (cv) or limited partnership",
  firm: "firm",
  investment_fund_selling_agent: "investment fund selling agent",
  peer_to_peer_lending: "peer to peer lending",
  permanent_establishment: "permanent establishment",
  sole_proprietorship: "sole proprietorship",
  corporate: "corporate",
  association: "association/social organizations",
  state_owned_enterprises: "state owned enterprises",
  central_bank: "central bank",
  state_owned_company: "state owned company",
  diocese: "diocese",
  conference: "conference",
  congregation: "congregation",
  cooperatives: "cooperatives",
  international_organization: "international organization",
  political_parties: "political parties",
  partnership: "partnership",
  educational_institution: "educational institution",
  mutual_funds: "mutual funds (mf)",
  securities_company: "securities company (sc)",
  pension_funds: "pension funds (pf)",
  financial_institutional: "financial institutional (ib)",
  insurance: "insurance (is)",
  foundation: "foundation (fd)",
  individual: "individual (id)",
} as const
type Classification = keyof typeof CLASSIFICATIONS

const BY_LABEL = new Map<string, Classification>(
  Object.entries(CLASSIFICATIONS).map(([slug, label]) => [
    label,
    slug as Classification,
  ])
)

const Origin = Schema.Literals(["local", "foreign", "combined"])
type Origin = typeof Origin.Type

class ClassificationUnreadable extends Schema.TaggedError<ClassificationUnreadable>()(
  "ClassificationUnreadable",
  { message: Schema.String }
) {}

const unreadable = (message: string) =>
  new ClassificationUnreadable({ message })

// A header cell's label and origin: `Local_Bank` is ("bank", local), `BANK`
// ("bank", combined), `SHARE_CODE` ("share code", combined).
const headerLabel = (cell: Cell) => {
  const text = typeof cell === "string" ? cell.trim().toLowerCase() : ""
  const split = /^(local|foreign)_(.*)$/.exec(text)
  const label = (split?.[2] ?? text.replaceAll("_", " "))
    .replaceAll(/\s+/g, " ")
    .trim()
  return { label, origin: (split?.[1] ?? "combined") as Origin }
}

interface Layout {
  readonly headerRow: number
  readonly code: number
  readonly issuer: number
  readonly total: number
  readonly classifications: ReadonlyArray<{
    readonly column: number
    readonly classification: Classification
    readonly origin: Origin
  }>
}

// Every classification column of a header row: each labelled column but
// `known` (DATE, SHARE CODE, ISSUER NAME, TOTAL SCRIPLESS). A layout names
// each of the 39 once, all `combined` (Mar–Aug) or each as `local` and as
// `foreign` (Sep+).
const classificationColumns = Effect.fnUntraced(function* (
  headerRow: number,
  cells: ReadonlyArray<Cell>,
  known: ReadonlySet<number>
) {
  const columns: Array<Layout["classifications"][number]> = []
  const seen = new Set<string>()
  for (const [column, cell] of cells.entries()) {
    const { label, origin } = headerLabel(cell)
    if (label === "" || known.has(column)) continue
    const classification = BY_LABEL.get(label)
    if (classification === undefined)
      return yield* unreadable(
        `Header row ${headerRow} names an unknown classification: ${String(cell).trim()}`
      )
    if (seen.has(`${origin}:${classification}`))
      return yield* unreadable(
        `Header row ${headerRow} names ${String(cell).trim()} twice`
      )
    seen.add(`${origin}:${classification}`)
    columns.push({ column, classification, origin })
  }
  const count = Object.keys(CLASSIFICATIONS).length
  const ofOrigin = (origin: Origin) =>
    columns.filter((column) => column.origin === origin).length
  const combined = ofOrigin("combined") === count && columns.length === count
  const split =
    ofOrigin("local") === count &&
    ofOrigin("foreign") === count &&
    columns.length === 2 * count
  if (!combined && !split)
    return yield* unreadable(
      `Header row ${headerRow} matches neither layout: it names ${columns.length} classification columns, not the ${count} classifications once each, or once each as Local_ and as Foreign_`
    )
  return columns
})

// The header row is found by its labels: row 6 in the Mar–Aug 2026 layout
// (`DATE`, `SHARE CODE`, `ISSUER NAME`, 39 classifications, `TOTAL
// SCRIPLESS`), row 4 from Sep 2026 (`DATE`, `SHARE_CODE`, `ISSUER_NAME`,
// `Local_<class>` × 39, `Foreign_<class>` × 39, `Total Scripless`). Cells
// past the labelled columns, such as May 2026's empty trailing one, are
// never read.
const findLayout = Effect.fnUntraced(function* (
  rows: ReadonlyMap<number, ReadonlyArray<Cell>>
) {
  for (const [headerRow, cells] of rows) {
    const labels = cells.map((cell) => headerLabel(cell).label)
    const code = labels.indexOf("share code")
    if (code === -1) continue
    const issuer = labels.indexOf("issuer name")
    if (issuer === -1)
      return yield* unreadable(`Header row ${headerRow} has no ISSUER NAME`)
    const total = labels.indexOf("total scripless")
    if (total === -1)
      return yield* unreadable(`Header row ${headerRow} has no TOTAL SCRIPLESS`)
    const known = new Set([labels.indexOf("date"), code, issuer, total])
    return {
      headerRow,
      code,
      issuer,
      total,
      classifications: yield* classificationColumns(headerRow, cells, known),
    } satisfies Layout
  }
  return yield* unreadable("No header row names SHARE CODE")
})

const shareCount = Effect.fnUntraced(function* (
  cell: Cell | undefined,
  where: string
) {
  if (cell === null || cell === undefined) return 0
  if (typeof cell === "number" && Number.isSafeInteger(cell) && cell >= 0)
    return cell
  return yield* unreadable(`${where} isn't a share count: ${String(cell)}`)
})

type Holding = [string, Classification, Origin, number]

const formatShares = (count: number) => count.toLocaleString("en-US")

// One stock row's non-zero holdings, and in a split month each
// classification's `combined` sum of local and foreign. Its classifications
// must sum to its total.
const rowHoldings = Effect.fnUntraced(function* (
  stock: string,
  cells: ReadonlyArray<Cell>,
  layout: Layout,
  total: number,
  where: string
) {
  const holdings: Array<Holding> = []
  const combined = new Map<Classification, number>()
  let sum = 0
  for (const { column, classification, origin } of layout.classifications) {
    const shares = yield* shareCount(cells[column], where)
    sum += shares
    if (shares === 0) continue
    holdings.push([stock, classification, origin, shares])
    if (origin !== "combined")
      combined.set(classification, (combined.get(classification) ?? 0) + shares)
  }
  if (sum !== total)
    return yield* unreadable(
      `${where}'s classifications sum to ${formatShares(sum)}, not its TOTAL SCRIPLESS of ${formatShares(total)}`
    )
  for (const [classification, shares] of combined)
    holdings.push([stock, classification, "combined", shares])
  return holdings
})

// One month's rows: a stock-month per stock, and its holdings.
const parseRows = Effect.fnUntraced(function* (
  rows: ReadonlyMap<number, ReadonlyArray<Cell>>
) {
  const layout = yield* findLayout(rows)
  const stocks: Array<[string, string, number]> = []
  const holdings: Array<Holding> = []
  for (const [rowNumber, cells] of rows) {
    const code = cells[layout.code]
    if (rowNumber <= layout.headerRow || typeof code !== "string") continue
    const stock = code.trim()
    if (stock === "") continue
    const where = `${stock} (row ${rowNumber})`
    const total = yield* shareCount(cells[layout.total], `${where}'s total`)
    stocks.push([stock, String(cells[layout.issuer] ?? "").trim(), total])
    holdings.push(...(yield* rowHoldings(stock, cells, layout, total, where)))
  }
  if (stocks.length === 0) return yield* unreadable("The report has no stocks")
  return { stocks, holdings }
})

// Parses one archived report and replaces its data date's parsed holdings
// with it, recording the version it came from. The number of stocks parsed.
export const parseClassificationMonth = Effect.fnUntraced(function* (
  dataDate: string,
  sha256: string,
  bytes: Uint8Array,
  parsedAt: string
) {
  const { stocks, holdings } = yield* parseRows(yield* readSheet(bytes))
  yield* replaceMonth({
    dateColumn: "data_date",
    date: dataDate,
    tables: [
      {
        table: "classification_holding",
        columns: ["stock_code", "classification", "origin", "shares"],
        rows: holdings,
      },
      {
        table: "classification_stock_month",
        columns: ["stock_code", "issuer_name", "total_scripless"],
        rows: stocks,
      },
    ],
    record: {
      table: "classification_month",
      values: {
        sha256,
        parser_version: PARSER_VERSION,
        parsed_at: parsedAt,
      } satisfies Record<string, SqlValue>,
    },
  })
  return stocks.length
})

// The version each parsed month came from, by data date.
export const parsedClassificationMonths = Effect.gen(function* () {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: "SELECT data_date, sha256, parser_version FROM classification_month",
      params: [],
    },
  ])
  const months = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        data_date: Schema.String,
        sha256: Schema.String,
        parser_version: Schema.Number,
      })
    )
  )(rows)
  return new Map(
    months.map(({ data_date, sha256, parser_version }) => [
      data_date,
      { sha256, parserVersion: parser_version },
    ])
  )
})

const StockMonthRow = Schema.Struct({
  issuer_name: Schema.String,
  total_scripless: Schema.Number,
})
const HoldingRow = Schema.Struct({
  classification: Schema.String,
  origin: Origin,
  shares: Schema.Number,
})

// A stock's month in the classification report: its stock-month and its
// holdings, read in one batch so a month being replaced reads whole.
// Undefined when the month's report has no row for the stock.
export const classificationStockMonth = Effect.fnUntraced(function* (
  dataDate: string,
  code: string
) {
  const [stockRows = [], holdingRows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: "SELECT issuer_name, total_scripless FROM classification_stock_month WHERE data_date = ? AND stock_code = ?",
      params: [dataDate, code],
    },
    {
      sql: "SELECT classification, origin, shares FROM classification_holding WHERE data_date = ? AND stock_code = ?",
      params: [dataDate, code],
    },
  ])
  const [stock] = Schema.decodeUnknownSync(Schema.Array(StockMonthRow))(
    stockRows
  )
  if (stock === undefined) return undefined
  return {
    issuerName: stock.issuer_name,
    totalScripless: stock.total_scripless,
    holdings: Schema.decodeUnknownSync(Schema.Array(HoldingRow))(holdingRows),
  }
})
