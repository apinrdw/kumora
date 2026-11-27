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
import { holderKey } from "./holder-key.ts"
import {
  above1Months,
  above5Days,
  Above1HoldingRow,
  Above5HolderRow,
  Above5SecuritiesAccountRow,
} from "./stock-page.ts"

// The stocks the landing view lists.
const MOST_HELD = 20

// A holder's move against its band's period before: the trading day before
// for the 5% band, the month before for the 1% band, as Holder moves'
// derivation stored it.
const HolderMapMove = Schema.Struct({
  kind: Schema.Literals(["new", "up", "down", "transfer"]),
  // In shares: a New holder's whole holding.
  shareChange: Schema.UndefinedOr(Schema.Number),
  // % × 100; undefined on a New holder.
  percentageChange: Schema.UndefinedOr(Schema.Number),
})

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
  // Undefined when it holds as it did, or nothing is compared.
  move: Schema.UndefinedOr(HolderMapMove),
})
export type HolderMapLink = typeof HolderMapLink.Type

// A holder that left the focus's list: the day's above-5% list or the
// month's ≥1% list.
const HolderMapOffList = Schema.Struct({
  code: StockCode,
  // The report it left: the 5% band's or the 1% band's.
  band: HolderMapLink.fields.band,
  holder: Schema.String,
  // Its last listing's name.
  name: Schema.String,
  // The period it left, the first it was missing from: a trading day or an
  // above-1% report.
  since: WibDate,
  // Its last listing's %, × 100.
  percentageHundredths: Schema.Number,
})
export type HolderMapOffList = typeof HolderMapOffList.Type

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
  // The focus's earlier holders: off its list in its band's period and in
  // neither band now, each once, by its latest leaving. None without a
  // focus.
  offList: Schema.Array(HolderMapOffList),
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
  // Its listed holders' stored moves: the day's against the trading day
  // before, the month's against the month before. A period's lines of a
  // stock are at most its holders.
  //
  // Decision: Holder moves are derived at parse time
  // (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
  `${PERIODS}
  SELECT '5%' AS band, name, move, share_change, percentage_change
  FROM above_5_move
  WHERE stock_code = ?2 AND data_date = (SELECT day FROM asof)
    AND move <> 'off list'
  UNION ALL
  SELECT '1%' AS band, name, move, share_change, percentage_change
  FROM above_1_move
  WHERE stock_code = ?2 AND data_date = (SELECT month FROM band_month)
    AND move <> 'off list'`,
  // Its holders off the list as of the day and the month: each identity's
  // newest leaving, unless it came back since. A stock's identities are at
  // most its holders across its periods.
  `${PERIODS}
  SELECT band, name, data_date, stake_before FROM (
    SELECT '5%' AS band, name, move, data_date, stake_before,
      ROW_NUMBER() OVER (PARTITION BY holder ORDER BY data_date DESC) AS nth
    FROM above_5_move
    WHERE stock_code = ?2 AND move IN ('new', 'off list')
      AND data_date <= (SELECT day FROM asof)
    UNION ALL
    SELECT '1%' AS band, name, move, data_date, stake_before,
      ROW_NUMBER() OVER (PARTITION BY holder ORDER BY data_date DESC) AS nth
    FROM above_1_move
    WHERE stock_code = ?2 AND move IN ('new', 'off list')
      AND data_date <= (SELECT month FROM band_month)
  )
  WHERE nth = 1 AND move = 'off list'`,
]

const OffListRow = Schema.Struct({
  band: HolderMapLink.fields.band,
  name: Schema.String,
  data_date: WibDate,
  stake_before: Schema.Number,
})

// The focus's earlier holders by key, each by its latest leaving of either
// list.
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0141-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
const earlierHolders = Effect.fnUntraced(function* (
  code: StockCode,
  rows: ReadonlyArray<typeof OffListRow.Type>
) {
  const byKey = new Map<string, HolderMapOffList>()
  for (const row of rows) {
    const key = yield* holderKey(row.name)
    const known = byKey.get(key)
    if (known !== undefined && known.since >= row.data_date) continue
    byKey.set(key, {
      code,
      band: row.band,
      holder: key,
      name: row.name,
      since: row.data_date,
      percentageHundredths: row.stake_before,
    })
  }
  return byKey
})

const MoveRow = Schema.Struct({
  band: HolderMapLink.fields.band,
  name: Schema.String,
  move: HolderMapMove.fields.kind,
  share_change: Schema.NullOr(Schema.Number),
  percentage_change: Schema.NullOr(Schema.Number),
})

// Each band's stored moves by holder key. Holder moves follows a holder by
// its identity within the stock (ADR 0129), the map by key, so a key whose
// blocks are two identities, as CPGT's two ASIA ARGENTUM blocks, takes
// their summed change: New only when each is New. A block that holds as it
// did has no line, so a key with one New block beside it reads New too.
const movesByKey = Effect.fnUntraced(function* (
  rows: ReadonlyArray<typeof MoveRow.Type>
) {
  const lines = new Map<string, Array<typeof MoveRow.Type>>()
  for (const row of rows) {
    const at = `${row.band} ${yield* holderKey(row.name)}`
    lines.set(at, [...(lines.get(at) ?? []), row])
  }
  const moves = new Map<string, typeof HolderMapMove.Type>()
  for (const [at, of] of lines) {
    const sum = (field: "share_change" | "percentage_change") =>
      of.some((row) => row[field] === null)
        ? undefined
        : of.reduce((total, row) => total + (row[field] ?? 0), 0)
    const shareChange = sum("share_change")
    const percentageChange = sum("percentage_change")
    const [only] = of
    const kind =
      of.length === 1 && only !== undefined
        ? only.move
        : of.every(({ move }) => move === "new")
          ? "new"
          : yield* summedKind(
              of[0]?.band === "5%" ? shareChange : percentageChange,
              of.some(({ move }) => move === "transfer")
            )
    if (kind !== undefined)
      moves.set(at, { kind, shareChange, percentageChange })
  }
  return moves
})

// A key's summed move, by shares on a day and by % on a month, as each
// report's moves go.
const summedKind = (change: number | undefined, transfer: boolean) =>
  Effect.succeed<typeof HolderMapMove.Type.kind | undefined>(
    change === undefined || change === 0
      ? transfer
        ? "transfer"
        : undefined
      : change > 0
        ? "up"
        : "down"
  )

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
  monthRows: ReadonlyArray<typeof Above1MapRow.Type>,
  moves: ReadonlyMap<string, typeof HolderMapMove.Type>
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
      move: moves.get(`5% ${key}`),
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
      move: moves.get(`1% ${holder.key}`),
    })
  }
  return links
})

const SearchRow = Schema.Struct({
  stock_code: StockCode,
  issuer_name: Schema.String,
})

// The stocks the map's search offers: those the newest above-5% day or the
// newest above-1% month lists, by code, a code that isn't a stock code's
// shape left out. The stock page's list comes from the classification,
// KSEI and investor-type reports, which can miss a stock with holders.
export const holderMapStocks = Effect.gen(function* () {
  const [rows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: `SELECT stock_code, MAX(issuer_name) AS issuer_name FROM (
          SELECT stock_code, issuer_name FROM above_5_holder
          WHERE data_date = (SELECT MAX(data_date) FROM above_5_day)
          UNION ALL
          SELECT stock_code, issuer_name FROM above_1_holding
          WHERE data_date = (SELECT MAX(data_date) FROM above_1_month)
        )
        GROUP BY stock_code ORDER BY stock_code`,
      params: [],
    },
  ])
  const isRow = Schema.is(SearchRow)
  return rows.flatMap((row) =>
    isRow(row) ? [{ code: row.stock_code, issuerName: row.issuer_name }] : []
  )
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
      offList: [],
      mostHeld: (yield* decodeRows(MostHeldRow)(rest[0] ?? [])).map(
        ({ stock_code, issuer_name, holders }) => ({
          code: stock_code,
          issuerName: issuer_name,
          holders,
        })
      ),
    })
  const [
    holderRows = [],
    accountRows = [],
    monthRows = [],
    moveRows = [],
    offListRows = [],
  ] = rest
  const holders = yield* decodeRows(Above5HolderRow)(holderRows)
  const months = yield* decodeRows(Above1MapRow)(monthRows)
  const links = yield* stockLinks(
    focus.code,
    shownDay,
    month,
    holders,
    yield* decodeRows(Above5SecuritiesAccountRow)(accountRows),
    months,
    yield* movesByKey(yield* decodeRows(MoveRow)(moveRows))
  )
  const linked = new Set(links.map(({ holder }) => holder))
  const earlier = yield* earlierHolders(
    focus.code,
    yield* decodeRows(OffListRow)(offListRows)
  )
  return HolderMapRead.make({
    day: shownDay,
    month,
    focus: {
      kind: "stock",
      code: focus.code,
      issuerName: holders[0]?.issuer_name ?? months[0]?.issuer_name,
    },
    links,
    offList: [...earlier.values()].filter(({ holder }) => !linked.has(holder)),
    mostHeld: [],
  })
})
