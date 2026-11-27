// The Holder map's read (spec apinrdw/kumora#733, "Holder map read"): as of
// one trading day, the focus's links in two bands, the day's above-5%
// holders and the ≥1% holders of the newest above-1% month on or before
// it, and the links a hop beyond: a focus stock's holders' other stocks, or
// a focus holder's stocks' other holders. With no focus, the stocks with
// the most ≥1% holders.
import { StockCode, WibDate } from "@workspace/relay"
import { Effect, Schema } from "effect"

import {
  HolderKey,
  type HolderMapQuery,
  type SplitOrigin,
} from "@/domain/holdings"
import { dayHolders } from "@/lib/daily-holders"
import { placeOf } from "@/lib/holder-map-ids"

import { decodeRows } from "../d1.ts"
import { MAX_ROWS } from "./above-5.ts"
import { HoldingsDb, type HoldingsDbError } from "./db.ts"
import {
  type Account,
  custodianLinks,
  custodianNames,
  custodianOf,
  custodianSpellings,
  type HoldingAccounts,
} from "./holder-map-custodians.ts"
import {
  changesOf,
  LeavingRow,
  leavings,
  MoveRow,
  movesByKey,
} from "./holder-map-moves.ts"
import {
  type Focus,
  type HolderMapCustodianLink,
  type HolderMapFocus,
  type HolderMapLink,
  type HolderMapOffList,
  HolderMapRead,
  PERIODS,
  PERIODS_SQL,
  PeriodsRow,
  type StockLink,
} from "./holder-map-schema.ts"
import {
  above1Months,
  above5Days,
  Above1HoldingRow,
  Above5HolderRow,
  Above5SecuritiesAccountRow,
} from "./stock-page.ts"

// The stocks the landing view lists.
const MOST_HELD = 20

// The stocks a focus's map reads, `in_view`, from ?2: a stock focus's code
// and every stock its holders hold in either band, or every stock a focus
// holder's key holds in either band, or every stock with a securities
// account of the day at a focus custodian, ?2 then its spellings as a JSON
// array (`custodianSpellings`). A holder holds a stock on the map by its
// key, whatever stock it was first listed in.
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0141-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
const IN_VIEW: Record<Focus["kind"], string> = {
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
  // Through above_5_account_by_custodian: the custodian's accounts of the
  // day, not the whole day's.
  custodian: `${PERIODS},
  in_view AS (
    SELECT DISTINCT stock_code FROM above_5_account
    WHERE custodian IN (SELECT value FROM json_each(?2))
      AND data_date = (SELECT day FROM asof)
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

// The most earlier holders a custodian focus reads: one day's accounts at
// the above-5% parse's cap (ADR 0045).
const CUSTODIAN_OFF_LIST = MAX_ROWS

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
const OFF_LIST: Record<Focus["kind"], string> = {
  stock: `${PERIODS} ${OFF_LIST_LINES("stock_code = ?2")}`,
  // An identity is `<key>#<n>`: those of the key sort from `<key>#` up to,
  // not including, `<key>$`.
  holder: `${PERIODS} ${OFF_LIST_LINES("holder >= ?2 || '#' AND holder < ?2 || '$'")}`,
  // A custodian's earlier holders: each above-5% holding with an account
  // at one of its spellings of the day (?2) on a day before it, by its
  // last such day, the period it left the first above-5% day after. A
  // holding still there is dropped after (`offListOf`). Holder moves store
  // no custodian, so this reads the accounts through
  // above_5_account_by_custodian, every earlier day's at the custodian, and
  // keeps the CUSTODIAN_OFF_LIST newest holdings: as many as one day's
  // accounts at the parse's cap (ADR 0045). A spelling the custodian no
  // longer uses on the day is missed.
  custodian: `${PERIODS},
  through AS (
    SELECT DISTINCT data_date, stock_code, no FROM above_5_account
    WHERE custodian IN (SELECT value FROM json_each(?2))
      AND data_date < (SELECT day FROM asof)
  ),
  last_through AS (
    SELECT holder.stock_code, holder.holder_key,
      MAX(holder.data_date) AS last_day
    FROM through JOIN above_5_holder AS holder
      USING (data_date, stock_code, no)
    GROUP BY holder.stock_code, holder.holder_key
    ORDER BY last_day DESC, holder.stock_code, holder.holder_key
    LIMIT ${CUSTODIAN_OFF_LIST}
  )
  SELECT last_through.stock_code, holder.issuer_name, '5%' AS band,
    holder.holder_name AS name,
    (SELECT MIN(data_date) FROM above_5_day
      WHERE data_date > last_through.last_day) AS data_date,
    MAX(holder.percentage_hundredths) AS stake_before
  FROM last_through JOIN above_5_holder AS holder
    ON holder.data_date = last_through.last_day
      AND holder.stock_code = last_through.stock_code
      AND holder.holder_key = last_through.holder_key
  GROUP BY last_through.stock_code, last_through.holder_key`,
}

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

const OffListRow = Schema.Struct({
  ...LeavingRow.fields,
  issuer_name: Schema.String,
})

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
  // Keys as the map's: the read's boundary.
  const monthHolders = new Map(
    (held?.holders ?? []).map((holder) => [HolderKey.make(holder.key), holder])
  )
  const typeOf = (key: HolderKey) =>
    monthHolders.get(key)?.rows.find(({ type }) => type !== undefined)?.type

  const above5 = new Map<
    HolderKey,
    {
      name: string
      hundredths: number
      shares: number
      origins: Array<SplitOrigin>
      accounts: Array<Account>
    }
  >()
  for (const holder of yield* dayHolders(blocks?.holders ?? [])) {
    const key = HolderKey.make(holder.key)
    const summed = above5.get(key)
    const origins = holder.accounts.map(({ origin }) => origin)
    if (summed === undefined)
      above5.set(key, {
        name: holder.name,
        hundredths: holder.percentageHundredths,
        shares: holder.scripless,
        origins,
        accounts: [...holder.accounts],
      })
    else {
      summed.hundredths += holder.percentageHundredths
      summed.shares += holder.scripless
      summed.origins.push(...origins)
      summed.accounts.push(...holder.accounts)
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
  for (const [key, holder] of monthHolders) {
    if (inAbove5.has(key)) continue
    links.push({
      code,
      band: "1%",
      holder: key,
      name: holder.rows[0]?.name ?? key,
      percentageHundredths: holder.percentageHundredths,
      shares: holder.total,
      origin: yield* originOf(holder.rows.map(({ origin }) => origin)),
      investorType: typeOf(key),
    })
  }
  return {
    links,
    // Each 5%-band holder's securities accounts, by key.
    accounts: new Map(
      [...above5].map(([key, holder]) => [key, holder.accounts])
    ),
    inMonth: new Map(
      [...monthHolders].map(([key, holder]) => [
        key,
        holder.percentageHundredths,
      ])
    ),
  }
})

// ?2 of a focus's statements: a stock code, a holder key, or a custodian's
// spellings of the day as a JSON array.
const focusParam = (focus: Focus, spellings: ReadonlyArray<string>) =>
  Effect.sync((): string =>
    focus.kind === "stock"
      ? focus.code
      : focus.kind === "holder"
        ? focus.key
        : JSON.stringify(spellings)
  )

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
  const accounts: Array<HoldingAccounts> = []
  const issuers = new Map<StockCode, string>()
  for (const [code, rows] of stocks) {
    const issuer = rows.holders[0]?.issuer_name ?? rows.month[0]?.issuer_name
    if (issuer !== undefined) issuers.set(code, issuer)
    const stock = yield* stockLinks(code, periods.day, periods.month, rows)
    for (const [holder, of] of stock.accounts)
      accounts.push({ code, holder, accounts: of })
    links.push(...(yield* changesOf(periods, stock, moves, left)))
  }
  return { links, issuers, custodians: yield* custodianLinks(accounts) }
})

// The places of `links`.
const placesOf = Effect.fnUntraced(function* (
  links: Iterable<{ readonly code: string; readonly holder: HolderKey }>
) {
  const places = new Set<string>()
  for (const { code, holder } of links) places.add(yield* placeOf(code, holder))
  return places
})

// The first hop and the second: a stock focus's holders and each one's
// other stocks, a holder focus's stocks and each one's other holders, or a
// custodian focus's holdings, the 5%-band links with an account there, and
// none beyond.
const hopsOf = Effect.fnUntraced(function* (
  focus: Focus,
  links: ReadonlyArray<HolderMapLink>,
  custodians: ReadonlyArray<HolderMapCustodianLink>
) {
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
  if (focus.kind === "custodian") {
    const through = yield* placesOf(
      custodians.filter(({ custodian }) => custodian === focus.id)
    )
    const first: Array<HolderMapLink> = []
    for (const link of links)
      if (
        link.band === "5%" &&
        through.has(yield* placeOf(link.code, link.holder))
      )
        first.push(link)
    return { first, second: [] }
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

// The day asked for and a custodian focus's spellings: a custodian focus
// reads its spellings first (`custodianSpellings`), then the map as of the
// day they are of.
const askOf = Effect.fnUntraced(function* (
  focus: Focus | undefined,
  day: WibDate | undefined
) {
  if (focus?.kind !== "custodian")
    return { asked: day ?? null, spellings: [] as ReadonlyArray<string> }
  const { day: asked, spellings } = yield* custodianSpellings(
    focus.id,
    day ?? null
  )
  return { asked, spellings }
})

// The statements a focus reads after the periods and the days: the stocks
// most held with none, else the stocks in view and the focus's Off list.
const focusStatements = Effect.fnUntraced(function* (
  focus: Focus | undefined,
  asked: WibDate | null,
  spellings: ReadonlyArray<string>
) {
  if (focus === undefined) return [{ sql: MOST_HELD_SQL, params: [asked] }]
  const params = [asked, yield* focusParam(focus, spellings)]
  return [
    ...IN_VIEW_ROWS.map((sql) => ({
      sql: `${IN_VIEW[focus.kind]} ${sql}`,
      params,
    })),
    { sql: OFF_LIST[focus.kind], params },
  ]
})

// The landing view's stocks most held.
const mostHeldOf = Effect.fnUntraced(function* (
  rows: ReadonlyArray<Record<string, unknown>>
) {
  return (yield* decodeRows(MostHeldRow)(rows)).map(
    ({ stock_code, issuer_name, holders }) => ({
      code: stock_code,
      issuerName: issuer_name,
      holders,
    })
  )
})

// The focus's Off list: its leavings in neither band now. A holding in
// either band now is no earlier one: a holder that left the above-5% list
// for the 1% band crossed down out of 5%. A custodian's are holdings no
// longer through it, whether they left the list or moved their account.
const offListOf = Effect.fnUntraced(function* (
  focus: Focus,
  first: ReadonlyArray<HolderMapLink>,
  rows: ReadonlyArray<typeof OffListRow.Type>
) {
  const linked = yield* placesOf(first)
  const offList: Array<HolderMapOffList> = []
  for (const [place, left] of yield* leavings(rows))
    if (
      !linked.has(place) &&
      (focus.kind !== "holder" || left.holder === focus.key)
    )
      offList.push(left)
  return offList
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
  const { asked, spellings } = yield* askOf(focus, day)
  const [periodRows = [], dayRows = [], ...rest] =
    yield* (yield* HoldingsDb).batch([
      { sql: PERIODS_SQL, params: [asked] },
      {
        sql: "SELECT data_date FROM above_5_day ORDER BY data_date",
        params: [],
      },
      ...(yield* focusStatements(focus, asked, spellings)),
    ])
  const [periods] = yield* decodeRows(PeriodsRow)(periodRows)
  const shownDay = periods?.day ?? undefined
  const month = periods?.month ?? undefined
  const dated = {
    day: shownDay,
    refused: shownDay === undefined ? day : undefined,
    days: (yield* decodeRows(DayRow)(dayRows)).map(
      ({ data_date }) => data_date
    ),
    month,
  }
  if (focus === undefined)
    return HolderMapRead.make({
      ...dated,
      focus: undefined,
      links: [],
      hops: [],
      custodians: [],
      issuers: [],
      offList: [],
      mostHeld: yield* mostHeldOf(rest[0] ?? []),
    })
  const { links, issuers, custodians } = yield* linksInView(
    { day: shownDay, month },
    rest.slice(0, IN_VIEW_ROWS.length)
  )
  const { first, second } = yield* hopsOf(focus, links, custodians)
  const offRows = yield* decodeRows(OffListRow)(rest[IN_VIEW_ROWS.length] ?? [])
  const offList = yield* offListOf(focus, first, offRows)
  for (const row of offRows)
    if (!issuers.has(row.stock_code))
      issuers.set(row.stock_code, row.issuer_name)
  const inView = yield* placesOf([...first, ...second])
  const custodiansInView: Array<HolderMapCustodianLink> = []
  for (const link of custodians)
    if (inView.has(yield* placeOf(link.code, link.holder)))
      custodiansInView.push(link)
  return HolderMapRead.make({
    ...dated,
    focus: yield* focusOf(
      focus,
      first,
      offList,
      issuers,
      custodians,
      spellings
    ),
    links: first,
    hops: second,
    custodians: custodiansInView,
    issuers: [...issuers]
      .map(([code, issuerName]) => ({ code, issuerName }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    offList,
    mostHeld: [],
  })
})

const focusOf = Effect.fnUntraced(function* (
  focus: Focus,
  links: ReadonlyArray<HolderMapLink>,
  offList: ReadonlyArray<HolderMapOffList>,
  issuers: ReadonlyMap<StockCode, string>,
  custodians: ReadonlyArray<HolderMapCustodianLink>,
  spellings: ReadonlyArray<string>
): Effect.fn.Return<HolderMapFocus> {
  if (focus.kind === "stock")
    return {
      kind: "stock",
      code: focus.code,
      issuerName: issuers.get(focus.code),
    }
  if (focus.kind === "custodian") {
    const named = custodians.find(({ custodian }) => custodian === focus.id)
    const [spelling] = spellings
    const known =
      named ??
      (spelling === undefined
        ? undefined
        : {
            broker: (yield* custodianOf(spelling)).broker,
            name: (yield* custodianNames([spelling])).get(focus.id),
          })
    return {
      kind: "custodian",
      id: focus.id,
      broker: known?.broker,
      name: known?.name,
    }
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
