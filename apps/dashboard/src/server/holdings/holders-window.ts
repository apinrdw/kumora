// The periods of a stock that one pass over its holders' identities reads
// (lib/holder-identity.ts): its newest parsed periods up to a given one
// whose rows fit the kind's row budget. A holder's identity in a period
// comes from every period read before it, so each reader of a kind takes
// its periods from here. The stock page's panels read a stock up to its
// newest parsed period (stock-page.ts), and Holder moves' derivation reads
// each moving stock up to the period it derives (derived-moves.ts).
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
  // The most rows of a stock its periods read hold. It fits a period and
  // the one before at the parse's cap, so a period's moves are always
  // right.
  readonly budget: number
}

// Above-5% days, for Daily holders. A day costs its row and its blocks' and
// accounts' rows: at the parse's cap a day holds MAX_ROWS accounts, each
// its own block.
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

// The CTE `read_from`: for each stock of the query `stocks` (its
// stock_code), `since`, the oldest of the periods read, and `rows`, their
// rows. The periods are the parsed ones up to the SQL expression `upTo`,
// or up to the newest without it.
export const readFrom = (
  { parsed, cost, budget }: HoldersWindow,
  stocks: string,
  upTo?: string
) => `
  period_cost AS (
    SELECT s.stock_code, d.data_date, ${cost} AS rows
    FROM (${stocks}) s, ${parsed} d
    ${upTo === undefined ? "" : `WHERE d.data_date <= ${upTo}`}
  ),
  read_from AS (
    SELECT stock_code, MIN(data_date) AS since, SUM(rows) AS rows
    FROM (
      SELECT stock_code, data_date, rows,
        SUM(rows) OVER (
          PARTITION BY stock_code ORDER BY data_date DESC
        ) AS total
      FROM period_cost
    )
    WHERE total <= ${budget}
    GROUP BY stock_code
  )`
