// The periods of a stock that one pass over its holders' identities reads
// (lib/holder-identity.ts): its newest parsed periods up to a given one
// whose rows fit a row budget. A holder's identity in a period comes from
// every period read before it, so each reader of a kind takes its periods
// from here. Holder moves' derivation reads each moving stock of one kind up
// to the period it derives (derived-moves.ts), within the kind's budget.
// The stock page reads both kinds of one stock up to their newest parsed
// periods (stock-page.ts), within one budget they share.
//
// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
import { MAX_HOLDING_ROWS } from "./above-1.ts"
import { MAX_ROWS } from "./above-5.ts"

export interface HoldersWindow {
  // The kind's parsed periods' table: data_date, sha256 and parser_version.
  readonly parsed: string
  // A SQL expression: the rows of the stock `s.stock_code` in the period
  // `d.data_date`, its own row included.
  readonly cost: string
  // The most rows of a stock its periods hold when the kind is read alone.
  // It fits a period and the one before at the parse's cap, so a period's
  // moves are always right.
  readonly budget: number
}

// Above-5% days, for Daily holders. A day costs its row and its blocks' and
// securities accounts' rows: at the parse's cap a day holds MAX_ROWS
// securities accounts, each its own block.
export const DAILY_WINDOW: HoldersWindow = {
  parsed: "above_5_day",
  cost: `1 + (
      SELECT COUNT(*) FROM above_5_holder h
      WHERE h.stock_code = s.stock_code AND h.data_date = d.data_date
    ) + (
      SELECT COUNT(*) FROM above_5_account a
      WHERE a.stock_code = s.stock_code AND a.data_date = d.data_date
    )`,
  budget: 2 * (2 * MAX_ROWS + 1),
}

// Above-1% months, for Major holders. A month costs its row and its
// holdings' rows.
export const MONTHLY_WINDOW: HoldersWindow = {
  parsed: "above_1_month",
  cost: `1 + (
      SELECT COUNT(*) FROM above_1_holding h
      WHERE h.stock_code = s.stock_code AND h.data_date = d.data_date
    )`,
  budget: 2 * (MAX_HOLDING_ROWS + 1),
}

// The most rows of one stock's holders its page reads, its days' and its
// months' together: two days at the cap, and beside them a real stock's
// every month. A stock has at most 28 rows a month (Sep 2026), so the 4,000
// hold over 11 years of months.
// tests/server/holdings/stock-page-heap.test.ts holds the heap it takes.
export const PAGE_BUDGET = DAILY_WINDOW.budget + 4_000

// The CTEs `${name}_cost` and `${name}`: for each stock of the query
// `stocks` (its stock_code), `since`, the oldest of the periods read, and
// `rows`, their rows. The periods are the parsed ones up to the SQL
// expression `upTo`, or up to the newest without it, whose rows fit the SQL
// expression `budget`, which may name the stock as `c.stock_code`.
const windowOf = (
  { parsed, cost }: HoldersWindow,
  name: string,
  stocks: string,
  upTo: string | undefined,
  budget: string
) => `
  ${name}_cost AS (
    SELECT s.stock_code, d.data_date, ${cost} AS rows
    FROM (${stocks}) s, ${parsed} d
    ${upTo === undefined ? "" : `WHERE d.data_date <= ${upTo}`}
  ),
  ${name} AS (
    SELECT stock_code, MIN(data_date) AS since, SUM(rows) AS rows
    FROM (
      SELECT stock_code, data_date, rows,
        SUM(rows) OVER (
          PARTITION BY stock_code ORDER BY data_date DESC
        ) AS total
      FROM ${name}_cost
    ) c
    WHERE total <= ${budget}
    GROUP BY stock_code
  )`

// The CTE `read_from`: one kind's periods of each stock of the query
// `stocks`, read alone, as Holder moves' derivation reads them.
export const readFrom = (
  window: HoldersWindow,
  stocks: string,
  upTo?: string
) => windowOf(window, "read_from", stocks, upTo, String(window.budget))

// The CTEs `months_read` and `days_read`: both kinds' periods of the stock
// `code` (a SQL expression), as its page reads them together. The months are
// read as alone, since a real stock's are few rows. The days fit what the
// months leave of PAGE_BUDGET, at most their own budget. So the page holds
// at most PAGE_BUDGET rows of a stock's holders, whatever each kind has. A
// stock whose months leave its newest day and the one before no room shows
// fewer days, down to none: that takes over 4,000 rows of months beside two
// days at the cap.
export const pageReadFrom = (code: string) => {
  const stocks = `SELECT ${code} AS stock_code`
  return `${windowOf(
    MONTHLY_WINDOW,
    "months_read",
    stocks,
    undefined,
    String(MONTHLY_WINDOW.budget)
  )},${windowOf(
    DAILY_WINDOW,
    "days_read",
    stocks,
    undefined,
    `MIN(${DAILY_WINDOW.budget}, ${PAGE_BUDGET} - COALESCE((
      SELECT m.rows FROM months_read m WHERE m.stock_code = c.stock_code
    ), 0))`
  )}`
}
