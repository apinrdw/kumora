-- The stock page reads a stock's KSEI holdings across every period end
-- (src/server/holdings/stock-page.ts). Both tables are keyed by period end
-- first, so without these that read scans every row of every month.
CREATE INDEX ksei_holding_by_stock ON ksei_holding (stock_code, period_end);

CREATE INDEX ksei_stock_month_by_stock
ON ksei_stock_month (stock_code, period_end);
