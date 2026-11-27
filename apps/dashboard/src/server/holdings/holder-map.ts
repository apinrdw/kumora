// The Holder map's read (spec apinrdw/kumora#733, "Holder map read"): as of
// one trading day, the focus stock's holders in two bands, the day's
// above-5% holders and the ≥1% holders of the newest above-1% month on or
// before it, or, with no focus, the stocks with the most ≥1% holders.
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import { type HolderMapQuery, KseiType, SplitOrigin } from "@/domain/holdings"
import { dayHolders } from "@/lib/daily-holders"

import { decodeRows } from "../d1.ts"
import { HoldingsDb, type HoldingsDbError } from "./db.ts"
import {
  above1Months,
  above5Days,
  Above1HoldingRow,
  Above5HolderRow,
  Above5SecuritiesAccountRow,
} from "./stock-page.ts"

// The stocks the landing view lists.
const MOST_HELD = 20

const HolderMapLink = Schema.Struct({
  code: StockCode,
  // The 5%-and-above band (the day's above-5% holders) or the 1%-to-5% band
  // (the month's ≥1% holders that aren't).
  band: Schema.Literals(["5%", "1%"]),
  // Its holder key: one holder across stocks and reports.
  holder: Schema.String,
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
})
export type HolderMapLink = typeof HolderMapLink.Type

const HolderMapRead = Schema.Struct({
  // The 5% band's trading day: the one asked for when parsed, else the
  // newest; undefined when no above-5% day is parsed.
  day: Schema.UndefinedOr(WibDate),
  // The 1% band's above-1% report: the newest on or before the day.
  month: Schema.UndefinedOr(WibDate),
  focus: Schema.UndefinedOr(
    Schema.Struct({
      kind: Schema.Literal("stock"),
      code: StockCode,
      // As the day's or the month's report prints it; undefined when
      // neither lists the stock.
      issuerName: Schema.UndefinedOr(Schema.String),
    })
  ),
  // The focus's holders, each a link between it and a holder.
  links: Schema.Array(HolderMapLink),
  // With no focus, the MOST_HELD stocks with the most ≥1% holders in the
  // month; none with a focus.
  mostHeld: Schema.Array(
    Schema.Struct({
      code: StockCode,
      issuerName: Schema.String,
      holders: Schema.Number,
    })
  ),
})
export type HolderMapRead = typeof HolderMapRead.Type

// The day the map is drawn as of, `asof`, and the 1% band's month,
// `band_month`. ?1 is the day asked for.
const PERIODS = `WITH asof AS (
    SELECT COALESCE(
      (SELECT data_date FROM above_5_day WHERE data_date = ?1),
      (SELECT MAX(data_date) FROM above_5_day)
    ) AS day
  ),
  band_month AS (
    SELECT MAX(data_date) AS month FROM above_1_month
    WHERE (SELECT day FROM asof) IS NULL OR data_date <= (SELECT day FROM asof)
  )`

const PeriodsRow = Schema.Struct({
  day: Schema.NullOr(WibDate),
  month: Schema.NullOr(WibDate),
})

const Above1MapRow = Schema.Struct({
  ...Above1HoldingRow.fields,
  issuer_name: Schema.String,
})

const MostHeldRow = Schema.Struct({
  stock_code: StockCode,
  issuer_name: Schema.String,
  holders: Schema.Number,
})

// One stock's day and month: a day's rows of a stock are at most the
// above-5% parse's cap, and a month's the above-1% parse's, a period of
// each kind, within the row budget of ADR 0133.
//
// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
const STOCK = [
  `${PERIODS}
  SELECT data_date, no, issuer_name, holder_name, holder_key, scripless,
    percentage_hundredths
  FROM above_5_holder
  WHERE stock_code = ?2 AND data_date = (SELECT day FROM asof)
  ORDER BY no`,
  `${PERIODS}
  SELECT data_date, no, custodian, account_name, origin, domicile, scripless
  FROM above_5_account
  WHERE stock_code = ?2 AND data_date = (SELECT day FROM asof)
  ORDER BY no, ordinal`,
  `${PERIODS}
  SELECT data_date, holder_key, investor_name, classification,
    investor_type, origin, domicile, controller, scripless, scrip, total,
    percentage_hundredths, issuer_name
  FROM above_1_holding
  WHERE stock_code = ?2 AND data_date = (SELECT month FROM band_month)
  ORDER BY seq`,
]

const MOST_HELD_SQL = `${PERIODS}
  SELECT stock_code, MAX(issuer_name) AS issuer_name,
    COUNT(DISTINCT holder_key) AS holders
  FROM above_1_holding WHERE data_date = (SELECT month FROM band_month)
  GROUP BY stock_code
  ORDER BY holders DESC, stock_code
  LIMIT ${MOST_HELD}`

const originOf = (origins: ReadonlyArray<SplitOrigin | undefined>) =>
  Effect.sync((): HolderMapLink["origin"] => {
    const set = new Set(origins.filter((origin) => origin !== undefined))
    if (set.size > 1) return "mixed"
    return [...set][0]
  })

// The stock's links: its above-5% holders of the day, repeat blocks
// collapsed and blocks of one holder key summed, then the month's ≥1%
// holders whose key none of the day's blocks carries.
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0141-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
const stockLinks = Effect.fnUntraced(function* (
  code: StockCode,
  day: WibDate | undefined,
  month: WibDate | undefined,
  holderRows: ReadonlyArray<typeof Above5HolderRow.Type>,
  accountRows: ReadonlyArray<typeof Above5SecuritiesAccountRow.Type>,
  monthRows: ReadonlyArray<typeof Above1MapRow.Type>
) {
  const [blocks] =
    day === undefined
      ? []
      : yield* above5Days(
          [{ data_date: day, listed_shares: null }],
          holderRows,
          accountRows
        )
  const [held] =
    month === undefined
      ? []
      : yield* above1Months([{ data_date: month }], monthRows)
  const monthHolders = new Map(
    (held?.holders ?? []).map((holder) => [holder.key, holder])
  )
  const typeOf = (key: string) =>
    monthHolders.get(key)?.rows.find(({ type }) => type !== undefined)?.type

  const above5 = new Map<
    string,
    {
      name: string
      hundredths: number
      shares: number
      origins: Array<SplitOrigin>
    }
  >()
  for (const holder of yield* dayHolders(blocks?.holders ?? [])) {
    const summed = above5.get(holder.key)
    const origins = holder.accounts.map(({ origin }) => origin)
    if (summed === undefined)
      above5.set(holder.key, {
        name: holder.name,
        hundredths: holder.percentageHundredths,
        shares: holder.scripless,
        origins,
      })
    else {
      summed.hundredths += holder.percentageHundredths
      summed.shares += holder.scripless
      summed.origins.push(...origins)
    }
  }
  const inAbove5 = new Set((blocks?.holders ?? []).map(({ key }) => key))
  const links: Array<HolderMapLink> = []
  for (const [key, holder] of above5)
    links.push({
      code,
      band: "5%",
      holder: key,
      name: holder.name,
      percentageHundredths: holder.hundredths,
      shares: holder.shares,
      origin: yield* originOf(holder.origins),
      investorType: typeOf(key),
    })
  for (const holder of held?.holders ?? []) {
    if (inAbove5.has(holder.key)) continue
    links.push({
      code,
      band: "1%",
      holder: holder.key,
      name: holder.rows[0]?.name ?? holder.key,
      percentageHundredths: holder.percentageHundredths,
      shares: holder.total,
      origin: yield* originOf(holder.rows.map(({ origin }) => origin)),
      investorType: typeOf(holder.key),
    })
  }
  return links
})

// The map of `query`, in one batch, so a parse run replacing a period
// mid-read can't mix two versions of it.
export const holderMapRead = Effect.fnUntraced(function* ({
  focus,
  day,
}: HolderMapQuery): Effect.fn.Return<
  HolderMapRead,
  HoldingsDbError,
  HoldingsDb
> {
  const asked = day ?? null
  const [periodRows = [], ...rest] = yield* (yield* HoldingsDb).batch([
    {
      sql: `${PERIODS}
      SELECT (SELECT day FROM asof) AS day,
        (SELECT month FROM band_month) AS month`,
      params: [asked],
    },
    ...(focus === undefined
      ? [{ sql: MOST_HELD_SQL, params: [asked] }]
      : STOCK.map((sql) => ({ sql, params: [asked, focus.code] }))),
  ])
  const [periods] = yield* decodeRows(PeriodsRow)(periodRows)
  const shownDay = periods?.day ?? undefined
  const month = periods?.month ?? undefined
  if (focus === undefined)
    return HolderMapRead.make({
      day: shownDay,
      month,
      focus: undefined,
      links: [],
      mostHeld: (yield* decodeRows(MostHeldRow)(rest[0] ?? [])).map(
        ({ stock_code, issuer_name, holders }) => ({
          code: stock_code,
          issuerName: issuer_name,
          holders,
        })
      ),
    })
  const [holderRows = [], accountRows = [], monthRows = []] = rest
  const holders = yield* decodeRows(Above5HolderRow)(holderRows)
  const months = yield* decodeRows(Above1MapRow)(monthRows)
  return HolderMapRead.make({
    day: shownDay,
    month,
    focus: {
      kind: "stock",
      code: focus.code,
      issuerName: holders[0]?.issuer_name ?? months[0]?.issuer_name,
    },
    links: yield* stockLinks(
      focus.code,
      shownDay,
      month,
      holders,
      yield* decodeRows(Above5SecuritiesAccountRow)(accountRows),
      months
    ),
    mostHeld: [],
  })
})
