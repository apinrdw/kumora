# Order-number captures, 2026-11-20 (after the close)

The scripts are stored as text so lint skips them; drop the `.txt` to run one.

Raw `exodus.stockbit.com/order-trade/running-trade` responses, gzipped, fetched at 20:2x WIB with the owner's session (token not stored). For [Capture real order-number rows for one code-day from each route](https://github.com/apinrdw/kumora/issues/618).

| File                                                  | Query                                                                              | Rows              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------- |
| `sb-HOPE-2026-11-20.json.gz`                          | `symbols=HOPE&date=2026-11-20`, ASC, every page (trade_number cursor), rows merged | 1,312             |
| `sb-BBCA-2026-11-20.json.gz`                          | `symbols=BBCA&date=2026-11-20`, ASC, every page, rows merged                       | 23,028            |
| `sb-hope-1120-p1.json.gz`                             | HOPE 2026-11-20, first page, raw response                                          | 100               |
| `sb-hope-2026-11-19-p1.json.gz`, `-10-20-`, `-06-15-` | HOPE on past days, first page                                                      | 100 each          |
| `sb-all-1120-desc.json.gz`                            | whole market, no `symbols`, DESC, one page                                         | 100 (94 RG, 6 NG) |

`market_board=NG` / `TN` as a query parameter answers 400 `INVALID_PARAMETER`.

## Aggressor order-number gaps

`python3 gaps.py.txt sb-HOPE-2026-11-20.json.gz sb-BBCA-2026-11-20.json.gz` → `gaps-output.txt`. For [Measure aggressor order-number gaps within a broker's second](https://github.com/apinrdw/kumora/issues/620).

## Ajaib Done Details, 2026-11-20 (20:4x WIB)

`v1/stock/data/broker-transaction?code=<code>&group=BS&start_time=00:00&end_time=23:59:59&market_date=2026-11-20&type=TRADE&page=<n>&page_size=1000`, every page, merged as `{meta, rows}`: `aj-dd-HOPE-1000.json.gz` (1,311 rows, 2 pages), `aj-dd-BBCA-1000.json.gz` (23,005 rows, 24 pages). `aj-dd-hope-0615.json.gz`: one page of 2026-06-15. `aj-rt-hope.json.gz`: Ajaib's per-code tape `v1/stock/detail/HOPE/running_trades/`, which has `trade_num` but no order field. `python3 join.py.txt <aj> <sb>` matches them to the Stockbit captures → `join-output.txt`. For [Capture Ajaib Done Details for HOPE and BBCA and match it to Stockbit's trades](https://github.com/apinrdw/kumora/issues/622).
