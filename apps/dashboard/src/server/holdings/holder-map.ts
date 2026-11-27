// The Holder map's read (spec apinrdw/kumora#733, "Holder map read"): as of
// one trading day, the focus's links in two bands, the day's above-5%
// holders and the ≥1% holders of the newest above-1% month on or before
// it, and the links a hop beyond: a focus stock's holders' other stocks, or
// a focus holder's stocks' other holders. With no focus, the stocks with
// the most ≥1% holders.
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import {
  type HolderKey,
  type HolderMapQuery,
  KseiType,
  SplitOrigin,
} from "@/domain/holdings"
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

// The 5% band's threshold, % × 100.
const FIVE_PERCENT = 500

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

// A holder that crossed 5% between the bands' periods: under 5% in the
// month and on the day's above-5% list, or off that list since a day after
// the month and still a ≥1% holder of it. It shows this, not its move.
const HolderMapCrossing = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("up into 5%"),
    // Its % × 100 in the month.
    monthHundredths: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("down out of 5%"),
    // The trading day it left the above-5% list.
    since: WibDate,
  }),
])

// One holding: a holder of a stock, in one band.
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
  // A gap holder: in the 1% band at 5% or more in the month, with no
  // above-5% holder of its key on the day.
  gap: Schema.Boolean,
  crossing: Schema.UndefinedOr(HolderMapCrossing),
})
export type HolderMapLink = typeof HolderMapLink.Type

// A holding the focus left: a stock focus's holder, or a holder focus's
// stock, off the day's above-5% list or the month's ≥1% list.
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

const HolderMapFocus = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("stock"),
    code: StockCode,
    // As the day's or the month's report prints it; undefined when
    // neither lists the stock.
    issuerName: Schema.UndefinedOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("holder"),
    key: Schema.String,
    // Its largest holding's name as published, else its latest Off list
    // name; undefined when neither report lists the key.
    name: Schema.UndefinedOr(Schema.String),
  }),
])
type HolderMapFocus = typeof HolderMapFocus.Type

const HolderMapRead = Schema.Struct({
  // The 5% band's trading day: the one asked for, else the newest;
  // undefined when it is refused or no above-5% day is parsed.
  day: Schema.UndefinedOr(WibDate),
  // The day asked for when no above-5% report of it is parsed: the map is
  // then drawn as of no day, with no links and no stocks.
  refused: Schema.UndefinedOr(WibDate),
  // Every parsed above-5% day, oldest first: the as-of picker's days.
  days: Schema.Array(WibDate),
  // The 1% band's above-1% report: the newest on or before the day.
  month: Schema.UndefinedOr(WibDate),
  focus: Schema.UndefinedOr(HolderMapFocus),
  // The first hop: a stock focus's holders, or a holder focus's stocks.
  links: Schema.Array(HolderMapLink),
  // The second hop: each first-hop holder's other stocks, or each
  // first-hop stock's other holders, every one, uncapped.
  hops: Schema.Array(HolderMapLink),
  // Each stock the links and the Off list reach, by code, with its issuer
  // name as its report prints it.
  issuers: Schema.Array(
    Schema.Struct({ code: StockCode, issuerName: Schema.String })
  ),
  // The focus's earlier holdings: off their list in their band's period and
  // in neither band now, each once, by its latest leaving. None without a
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
// `band_month`. ?1 is the day asked for, null for the newest; a day asked
// for that has no above-5% report leaves both null, so nothing is read.
// With no above-5% day parsed, the newest month is the 1% band's.
const PERIODS = `WITH asof AS (
    SELECT CASE WHEN ?1 IS NULL
      THEN (SELECT MAX(data_date) FROM above_5_day)
      ELSE (SELECT data_date FROM above_5_day WHERE data_date = ?1)
    END AS day
  ),
  band_month AS (
    SELECT MAX(data_date) AS month FROM above_1_month
    WHERE data_date <= (SELECT day FROM asof)
      OR (?1 IS NULL AND (SELECT day FROM asof) IS NULL)
  )`

// The stocks a focus's map reads, `in_view`, from ?2: a stock focus's code
// and every stock its holders hold in either band, or every stock a focus
// holder's key holds in either band. A holder holds a stock on the map by
// its key, whatever stock it was first listed in.
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0141-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
const IN_VIEW: Record<"stock" | "holder", string> = {
  stock: `${PERIODS},
  focus_keys AS (
    SELECT holder_key FROM above_5_holder
    WHERE stock_code = ?2 AND data_date = (SELECT day FROM asof)
    UNION
    SELECT holder_key FROM above_1_holding
    WHERE stock_code = ?2 AND data_date = (SELECT month FROM band_month)
  ),
  in_view AS (
    SELECT ?2 AS stock_code
    UNION
    SELECT stock_code FROM above_5_holder
    WHERE data_date = (SELECT day FROM asof)
      AND holder_key IN (SELECT holder_key FROM focus_keys)
    UNION
    SELECT stock_code FROM above_1_holding
    WHERE data_date = (SELECT month FROM band_month)
      AND holder_key IN (SELECT holder_key FROM focus_keys)
  )`,
  holder: `${PERIODS},
  in_view AS (
    SELECT stock_code FROM above_5_holder
    WHERE holder_key = ?2 AND data_date = (SELECT day FROM asof)
    UNION
    SELECT stock_code FROM above_1_holding
    WHERE holder_key = ?2 AND data_date = (SELECT month FROM band_month)
  )`,
}

const STOCKS_IN_VIEW = "stock_code IN (SELECT stock_code FROM in_view)"

// The stocks in view's day and month. A focus has no cap, so a nominee hub
// reads every stock: at most one whole day and one whole month, each
// within its report's parse cap (ADR 0045), and their stored lines.
//
// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
const IN_VIEW_ROWS = [
  `SELECT stock_code, data_date, no, issuer_name, holder_name, holder_key,
    scripless, percentage_hundredths
  FROM above_5_holder
  WHERE ${STOCKS_IN_VIEW} AND data_date = (SELECT day FROM asof)
  ORDER BY stock_code, no`,
  `SELECT stock_code, data_date, no, custodian, account_name, origin,
    domicile, scripless
  FROM above_5_account
  WHERE ${STOCKS_IN_VIEW} AND data_date = (SELECT day FROM asof)
  ORDER BY stock_code, no, ordinal`,
  `SELECT stock_code, data_date, holder_key, investor_name, classification,
    investor_type, origin, domicile, controller, scripless, scrip, total,
    percentage_hundredths, issuer_name
  FROM above_1_holding
  WHERE ${STOCKS_IN_VIEW} AND data_date = (SELECT month FROM band_month)
  ORDER BY stock_code, seq`,
  // Their listed holders' stored moves: the day's against the trading day
  // before, the month's against the month before. A period's lines of a
  // stock are at most its holders.
  //
  // Decision: Holder moves are derived at parse time
  // (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
  `SELECT stock_code, '5%' AS band, name, move, share_change,
    percentage_change
  FROM above_5_move
  WHERE ${STOCKS_IN_VIEW} AND data_date = (SELECT day FROM asof)
    AND move <> 'off list'
  UNION ALL
  SELECT stock_code, '1%' AS band, name, move, share_change,
    percentage_change
  FROM above_1_move
  WHERE ${STOCKS_IN_VIEW} AND data_date = (SELECT month FROM band_month)
    AND move <> 'off list'`,
  // The month's ≥1% holders that left the above-5% list after the month:
  // each identity's newest leaving between the month and the day, unless
  // it came back since. An identity starts with the key it was first
  // listed under (lib/holder-identity.ts), so matching it to the month's
  // keys keeps this to at most the month's holders; one renamed since is
  // missed, and shows its move, not Down out of 5%.
  `SELECT stock_code, '5%' AS band, name, data_date, stake_before FROM (
    SELECT stock_code, name, move, data_date, stake_before,
      ROW_NUMBER() OVER (
        PARTITION BY stock_code, holder ORDER BY data_date DESC
      ) AS nth
    FROM above_5_move AS line
    WHERE ${STOCKS_IN_VIEW} AND move IN ('new', 'off list')
      AND data_date > (SELECT month FROM band_month)
      AND data_date <= (SELECT day FROM asof)
      AND substr(holder, 1, instr(holder, '#') - 1) IN (
        SELECT holder_key FROM above_1_holding
        WHERE stock_code = line.stock_code
          AND data_date = (SELECT month FROM band_month)
      )
  )
  WHERE nth = 1 AND move = 'off list'`,
]

// The focus's leavings as of the day and the month: each identity's
// newest leaving, unless it came back since. A stock focus's are its
// identities', at most its holders across its periods. A holder focus's
// are every identity first listed under its key, in any stock, its
// listings' names matched to the key after.
const OFF_LIST_LINES = (where: string) => `SELECT stock_code, issuer_name,
    band, name, data_date, stake_before FROM (
    SELECT stock_code, issuer_name, '5%' AS band, name, move, data_date,
      stake_before,
      ROW_NUMBER() OVER (
        PARTITION BY stock_code, holder ORDER BY data_date DESC
      ) AS nth
    FROM above_5_move
    WHERE ${where} AND move IN ('new', 'off list')
      AND data_date <= (SELECT day FROM asof)
    UNION ALL
    SELECT stock_code, issuer_name, '1%' AS band, name, move, data_date,
      stake_before,
      ROW_NUMBER() OVER (
        PARTITION BY stock_code, holder ORDER BY data_date DESC
      ) AS nth
    FROM above_1_move
    WHERE ${where} AND move IN ('new', 'off list')
      AND data_date <= (SELECT month FROM band_month)
  )
  WHERE nth = 1 AND move = 'off list'`

// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0141-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
const OFF_LIST: Record<"stock" | "holder", string> = {
  stock: `${PERIODS} ${OFF_LIST_LINES("stock_code = ?2")}`,
  // An identity is `<key>#<n>`: those of the key sort from `<key>#` up to,
  // not including, `<key>$`.
  holder: `${PERIODS} ${OFF_LIST_LINES("holder >= ?2 || '#' AND holder < ?2 || '$'")}`,
}

const PeriodsRow = Schema.Struct({
  day: Schema.NullOr(WibDate),
  month: Schema.NullOr(WibDate),
})

const DayRow = Schema.Struct({ data_date: WibDate })

const Above5MapRow = Schema.Struct({
  ...Above5HolderRow.fields,
  stock_code: StockCode,
})
const Above5AccountMapRow = Schema.Struct({
  ...Above5SecuritiesAccountRow.fields,
  stock_code: StockCode,
})
const Above1MapRow = Schema.Struct({
  ...Above1HoldingRow.fields,
  stock_code: StockCode,
  issuer_name: Schema.String,
})

const MostHeldRow = Schema.Struct({
  stock_code: StockCode,
  issuer_name: Schema.String,
  holders: Schema.Number,
})

// A holding's leaving of its list: an above-5% day's or an above-1%
// month's Off-list line.
const LeavingRow = Schema.Struct({
  stock_code: StockCode,
  band: HolderMapLink.fields.band,
  name: Schema.String,
  data_date: WibDate,
  stake_before: Schema.Number,
})

const OffListRow = Schema.Struct({
  ...LeavingRow.fields,
  issuer_name: Schema.String,
})

// A holding's place: its stock and holder key.
const at = (code: string, key: string) => `${code} ${key}`

// Each holding's latest leaving of either list, by stock and key.
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0141-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
const leavings = Effect.fnUntraced(function* (
  rows: ReadonlyArray<typeof LeavingRow.Type>
) {
  const byPlace = new Map<string, HolderMapOffList>()
  for (const row of rows) {
    const key = yield* holderKey(row.name)
    const place = at(row.stock_code, key)
    const known = byPlace.get(place)
    if (known !== undefined && known.since >= row.data_date) continue
    byPlace.set(place, {
      code: row.stock_code,
      band: row.band,
      holder: key,
      name: row.name,
      since: row.data_date,
      percentageHundredths: row.stake_before,
    })
  }
  return byPlace
})

const MoveRow = Schema.Struct({
  stock_code: StockCode,
  band: HolderMapLink.fields.band,
  name: Schema.String,
  move: HolderMapMove.fields.kind,
  share_change: Schema.NullOr(Schema.Number),
  percentage_change: Schema.NullOr(Schema.Number),
})

// Each stock's bands' stored moves by holder key. Holder moves follows a
// holder by its identity within the stock (ADR 0129), the map by key, so a
// key whose blocks are two identities, as CPGT's two ASIA ARGENTUM blocks,
// takes their summed change: New only when each is New. A block that holds
// as it did has no line, so a key with one New block beside it reads New
// too.
const movesByKey = Effect.fnUntraced(function* (
  rows: ReadonlyArray<typeof MoveRow.Type>
) {
  const lines = new Map<string, Array<typeof MoveRow.Type>>()
  for (const row of rows) {
    const place = `${row.band} ${at(row.stock_code, yield* holderKey(row.name))}`
    const known = lines.get(place)
    if (known === undefined) lines.set(place, [row])
    else known.push(row)
  }
  const moves = new Map<string, typeof HolderMapMove.Type>()
  for (const [place, of] of lines) {
    const move = yield* summedMove(of)
    if (move !== undefined) moves.set(place, move)
  }
  return moves
})

// One key's lines as one move.
const summedMove = Effect.fnUntraced(function* (
  of: ReadonlyArray<typeof MoveRow.Type>
) {
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
  return kind === undefined
    ? undefined
    : ({
        kind,
        shareChange,
        percentageChange,
      } satisfies typeof HolderMapMove.Type)
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

// One stock's rows of the day and the month.
interface StockRows {
  readonly holders: Array<typeof Above5MapRow.Type>
  readonly accounts: Array<typeof Above5AccountMapRow.Type>
  readonly month: Array<typeof Above1MapRow.Type>
}

// The rows of each stock in view, by code, in the order read.
const byStock = (
  holders: ReadonlyArray<typeof Above5MapRow.Type>,
  accounts: ReadonlyArray<typeof Above5AccountMapRow.Type>,
  month: ReadonlyArray<typeof Above1MapRow.Type>
) =>
  Effect.sync(() => {
    const stocks = new Map<StockCode, StockRows>()
    const of = (code: StockCode) => {
      const known = stocks.get(code)
      if (known !== undefined) return known
      const rows: StockRows = { holders: [], accounts: [], month: [] }
      stocks.set(code, rows)
      return rows
    }
    for (const row of holders) of(row.stock_code).holders.push(row)
    for (const row of accounts) of(row.stock_code).accounts.push(row)
    for (const row of month) of(row.stock_code).month.push(row)
    return stocks
  })

// A stock's links: its above-5% holders of the day, repeat blocks
// collapsed and blocks of one holder key summed, then the month's ≥1%
// holders whose key none of the day's blocks carries.
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0141-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
const stockLinks = Effect.fnUntraced(function* (
  code: StockCode,
  day: WibDate | undefined,
  month: WibDate | undefined,
  rows: StockRows
) {
  const [blocks] =
    day === undefined
      ? []
      : yield* above5Days(
          [{ data_date: day, listed_shares: null }],
          rows.holders,
          rows.accounts
        )
  const [held] =
    month === undefined
      ? []
      : yield* above1Months([{ data_date: month }], rows.month)
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
  const links: Array<StockLink> = []
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
  return {
    links,
    inMonth: new Map(
      [...monthHolders].map(([key, holder]) => [
        key,
        holder.percentageHundredths,
      ])
    ),
  }
})

// A link before its changes are read.
type StockLink = Omit<HolderMapLink, "move" | "gap" | "crossing">

// What changed since each band's period before, and across the bands'
// periods (spec apinrdw/kumora#733, "Moves"): a stock's links' stored
// moves, the gap-holder mark, and a crossing of 5%.
const changesOf = Effect.fnUntraced(function* (
  periods: {
    readonly day: WibDate | undefined
    readonly month: WibDate | undefined
  },
  { links, inMonth }: Effect.Success<ReturnType<typeof stockLinks>>,
  moves: ReadonlyMap<string, typeof HolderMapMove.Type>,
  leftAbove5: ReadonlyMap<string, HolderMapOffList>
) {
  const out: Array<HolderMapLink> = []
  for (const link of links)
    out.push({
      ...link,
      move: moves.get(`${link.band} ${at(link.code, link.holder)}`),
      gap:
        link.band === "1%" &&
        periods.day !== undefined &&
        link.percentageHundredths >= FIVE_PERCENT,
      crossing: yield* crossingOf(
        link,
        periods.month,
        inMonth.get(link.holder),
        leftAbove5.get(at(link.code, link.holder))
      ),
    })
  return out
})

const crossingOf = (
  link: StockLink,
  month: WibDate | undefined,
  monthHundredths: number | undefined,
  left: HolderMapOffList | undefined
) =>
  Effect.sync((): HolderMapLink["crossing"] => {
    if (
      link.band === "5%" &&
      monthHundredths !== undefined &&
      monthHundredths < FIVE_PERCENT
    )
      return { kind: "up into 5%", monthHundredths }
    if (
      link.band === "1%" &&
      left !== undefined &&
      month !== undefined &&
      left.since > month
    )
      return { kind: "down out of 5%", since: left.since }
    return undefined
  })

const SearchStockRow = Schema.Struct({
  stock_code: StockCode,
  issuer_name: Schema.String,
})

const SearchHolderRow = Schema.Struct({
  holder_key: Schema.String,
  name: Schema.String,
})

const NEWEST_DAY = "(SELECT MAX(data_date) FROM above_5_day)"
const NEWEST_MONTH = "(SELECT MAX(data_date) FROM above_1_month)"

// What the map's search offers: the stocks and holders the newest above-5%
// day or the newest above-1% month lists, stocks by code, holders by key
// with a name of theirs, a code that isn't a stock code's shape left out.
// The stock page's list comes from the classification, KSEI and
// investor-type reports, which can miss a stock with holders. At most one
// day's and one month's rows, each within its parse cap (ADR 0045).
export const holderMapSearchList = Effect.gen(function* () {
  const [stockRows = [], holderRows = []] = yield* (yield* HoldingsDb).batch([
    {
      sql: `SELECT stock_code, MAX(issuer_name) AS issuer_name FROM (
          SELECT stock_code, issuer_name FROM above_5_holder
          WHERE data_date = ${NEWEST_DAY}
          UNION ALL
          SELECT stock_code, issuer_name FROM above_1_holding
          WHERE data_date = ${NEWEST_MONTH}
        )
        GROUP BY stock_code ORDER BY stock_code`,
      params: [],
    },
    {
      sql: `SELECT holder_key, MAX(name) AS name FROM (
          SELECT holder_key, holder_name AS name FROM above_5_holder
          WHERE data_date = ${NEWEST_DAY}
          UNION ALL
          SELECT holder_key, investor_name AS name FROM above_1_holding
          WHERE data_date = ${NEWEST_MONTH}
        )
        GROUP BY holder_key ORDER BY name`,
      params: [],
    },
  ])
  const isStock = Schema.is(SearchStockRow)
  const isHolder = Schema.is(SearchHolderRow)
  return {
    stocks: stockRows.flatMap((row) =>
      isStock(row)
        ? [{ code: row.stock_code, issuerName: row.issuer_name }]
        : []
    ),
    holders: holderRows.flatMap((row) =>
      isHolder(row) ? [{ key: row.holder_key, name: row.name }] : []
    ),
  }
})

type Focus = NonNullable<HolderMapQuery["focus"]>

const focusParam = (focus: Focus): string =>
  focus.kind === "stock" ? focus.code : focus.key

// Each stock in view's links, with their changes.
const linksInView = Effect.fnUntraced(function* (
  periods: {
    readonly day: WibDate | undefined
    readonly month: WibDate | undefined
  },
  rest: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>
) {
  const [
    holderRows = [],
    accountRows = [],
    monthRows = [],
    moveRows = [],
    leftRows = [],
  ] = rest
  const stocks = yield* byStock(
    yield* decodeRows(Above5MapRow)(holderRows),
    yield* decodeRows(Above5AccountMapRow)(accountRows),
    yield* decodeRows(Above1MapRow)(monthRows)
  )
  const moves = yield* movesByKey(yield* decodeRows(MoveRow)(moveRows))
  const left = yield* leavings(yield* decodeRows(LeavingRow)(leftRows))
  const links: Array<HolderMapLink> = []
  const issuers = new Map<StockCode, string>()
  for (const [code, rows] of stocks) {
    const issuer = rows.holders[0]?.issuer_name ?? rows.month[0]?.issuer_name
    if (issuer !== undefined) issuers.set(code, issuer)
    links.push(
      ...(yield* changesOf(
        periods,
        yield* stockLinks(code, periods.day, periods.month, rows),
        moves,
        left
      ))
    )
  }
  return { links, issuers }
})

// The first hop and the second: a stock focus's holders and each one's
// other stocks, or a holder focus's stocks and each one's other holders.
const hopsOf = (focus: Focus, links: ReadonlyArray<HolderMapLink>) =>
  Effect.sync(() => {
    if (focus.kind === "stock") {
      const first = links.filter(({ code }) => code === focus.code)
      const holders = new Set(first.map(({ holder }) => holder))
      return {
        first,
        second: links.filter(
          ({ code, holder }) => code !== focus.code && holders.has(holder)
        ),
      }
    }
    const first = links.filter(({ holder }) => holder === focus.key)
    const stocks = new Set(first.map(({ code }) => code))
    return {
      first,
      second: links.filter(
        ({ code, holder }) => holder !== focus.key && stocks.has(code)
      ),
    }
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
  const [periodRows = [], dayRows = [], ...rest] =
    yield* (yield* HoldingsDb).batch([
      {
        sql: `${PERIODS}
      SELECT (SELECT day FROM asof) AS day,
        (SELECT month FROM band_month) AS month`,
        params: [asked],
      },
      {
        sql: "SELECT data_date FROM above_5_day ORDER BY data_date",
        params: [],
      },
      ...(focus === undefined
        ? [{ sql: MOST_HELD_SQL, params: [asked] }]
        : [
            ...IN_VIEW_ROWS.map((sql) => ({
              sql: `${IN_VIEW[focus.kind]} ${sql}`,
              params: [asked, focusParam(focus)],
            })),
            { sql: OFF_LIST[focus.kind], params: [asked, focusParam(focus)] },
          ]),
    ])
  const [periods] = yield* decodeRows(PeriodsRow)(periodRows)
  const shownDay = periods?.day ?? undefined
  const month = periods?.month ?? undefined
  const refused = shownDay === undefined ? day : undefined
  const days = (yield* decodeRows(DayRow)(dayRows)).map(
    ({ data_date }) => data_date
  )
  if (focus === undefined)
    return HolderMapRead.make({
      day: shownDay,
      refused,
      days,
      month,
      focus: undefined,
      links: [],
      hops: [],
      issuers: [],
      offList: [],
      mostHeld: (yield* decodeRows(MostHeldRow)(rest[0] ?? [])).map(
        ({ stock_code, issuer_name, holders }) => ({
          code: stock_code,
          issuerName: issuer_name,
          holders,
        })
      ),
    })
  const { links, issuers } = yield* linksInView(
    { day: shownDay, month },
    rest.slice(0, IN_VIEW_ROWS.length)
  )
  const { first, second } = yield* hopsOf(focus, links)
  const offRows = yield* decodeRows(OffListRow)(rest[IN_VIEW_ROWS.length] ?? [])
  // A holding in either band now is no earlier one: a holder that left the
  // above-5% list for the 1% band crossed down out of 5%.
  const linked = new Set(first.map((link) => at(link.code, link.holder)))
  const offList = [...(yield* leavings(offRows)).values()].filter(
    (left) =>
      !linked.has(at(left.code, left.holder)) &&
      (focus.kind === "stock" || left.holder === focus.key)
  )
  for (const row of offRows)
    if (!issuers.has(row.stock_code))
      issuers.set(row.stock_code, row.issuer_name)
  return HolderMapRead.make({
    day: shownDay,
    refused,
    days,
    month,
    focus: yield* focusOf(focus, first, offList, issuers),
    links: first,
    hops: second,
    issuers: [...issuers]
      .map(([code, issuerName]) => ({ code, issuerName }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    offList,
    mostHeld: [],
  })
})

const focusOf = (
  focus: Focus,
  links: ReadonlyArray<HolderMapLink>,
  offList: ReadonlyArray<HolderMapOffList>,
  issuers: ReadonlyMap<StockCode, string>
) =>
  Effect.sync((): HolderMapFocus => {
    if (focus.kind === "stock")
      return {
        kind: "stock",
        code: focus.code,
        issuerName: issuers.get(focus.code),
      }
    const largest = links.reduce<HolderMapLink | undefined>(
      (most, link) =>
        most === undefined ||
        link.percentageHundredths > most.percentageHundredths
          ? link
          : most,
      undefined
    )
    const latest = offList.reduce<HolderMapOffList | undefined>(
      (newest, left) =>
        newest === undefined || left.since > newest.since ? left : newest,
      undefined
    )
    return {
      kind: "holder",
      key: focus.key satisfies HolderKey,
      name: largest?.name ?? latest?.name,
    }
  })
