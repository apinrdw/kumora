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
import { placeOf } from "@/lib/holder-map-ids"

import { decodeRows } from "../d1.ts"
import { HoldingsDb, type HoldingsDbError } from "./db.ts"
import {
  custodianLinks,
  custodianNames,
  custodianOf,
  custodianSpellings,
  type HoldingAccounts,
} from "./holder-map-custodians.ts"
import {
  Above1MapRow,
  Above5AccountMapRow,
  Above5MapRow,
  listedHolders,
  monthHolders,
} from "./holder-map-holders.ts"
import {
  changesOf,
  CrossingRow,
  crossingsDown,
  MoveRow,
  storedMoves,
} from "./holder-map-moves.ts"
import { OFF_LIST, offListOf, offListRead } from "./holder-map-off-list.ts"
import {
  type Budgeted,
  DAY_ROWS,
  type Focus,
  type HolderMapCustodianLink,
  type HolderMapFocus,
  type HolderMapLink,
  type HolderMapOffList,
  HolderMapRead,
  MONTH_ROWS,
  PERIODS,
  PERIODS_SQL,
  PeriodsRow,
  type StockLink,
} from "./holder-map-schema.ts"

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
// holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
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
  // day, not the whole day's. An account emptied to 0 shares holds nothing
  // there (`custodianLinks`).
  custodian: `${PERIODS},
  in_view AS (
    SELECT DISTINCT stock_code FROM above_5_account
    WHERE custodian IN (SELECT value FROM json_each(?2))
      AND data_date = (SELECT day FROM asof) AND scripless > 0
  )`,
}

const STOCKS_IN_VIEW = "stock_code IN (SELECT stock_code FROM in_view)"

// The trading day before the day drawn as of: the 5% band's moves are
// against it.
const DAY_BEFORE = `(SELECT MAX(data_date) FROM above_5_day
  WHERE data_date < (SELECT day FROM asof))`

// The day before's blocks `h` of the stocks in view whose key has another
// block that day or several on the day.
const BEFORE_SEVERAL = `FROM above_5_holder AS h
    WHERE h.stock_code IN (SELECT stock_code FROM in_view)
      AND h.data_date = ${DAY_BEFORE}
      AND (
        EXISTS (
          SELECT 1 FROM above_5_holder AS other
          WHERE other.data_date = h.data_date
            AND other.stock_code = h.stock_code
            AND other.holder_key = h.holder_key AND other.no <> h.no
        )
        OR (
          SELECT COUNT(*) FROM above_5_holder AS listed
          WHERE listed.data_date = (SELECT day FROM asof)
            AND listed.stock_code = h.stock_code
            AND listed.holder_key = h.holder_key
        ) > 1
      )`

// The day's blocks and accounts and the month's ≥1% rows that `links`
// are made of, of the stocks `where` picks, or of every stock with none:
// at most one whole day and one whole month, each within its report's
// parse cap (ADR 0045).
//
// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
export const linkRows = (where?: string): ReadonlyArray<Budgeted> => {
  const and = where === undefined ? "" : `${where} AND`
  return [
    {
      sql: `SELECT stock_code, data_date, no, issuer_name, holder_name,
        holder_key, scripless, percentage_hundredths
      FROM above_5_holder
      WHERE ${and} data_date = (SELECT day FROM asof)
      ORDER BY stock_code, no`,
      rows: DAY_ROWS,
    },
    {
      sql: `SELECT stock_code, data_date, no, custodian, account_name,
        origin, domicile, scripless
      FROM above_5_account
      WHERE ${and} data_date = (SELECT day FROM asof)
      ORDER BY stock_code, no, ordinal`,
      rows: DAY_ROWS,
    },
    {
      sql: `SELECT stock_code, data_date, holder_key, investor_name,
        classification, investor_type, origin, domicile, controller,
        scripless, scrip, total, percentage_hundredths, issuer_name
      FROM above_1_holding
      WHERE ${and} data_date = (SELECT month FROM band_month)
      ORDER BY stock_code, seq`,
      rows: MONTH_ROWS,
    },
  ]
}

// The stocks in view's day and month. A focus has no cap, so a nominee hub
// reads every stock (`linkRows`), and their stored lines.
//
// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
const IN_VIEW_ROWS: ReadonlyArray<Budgeted> = [
  ...linkRows(STOCKS_IN_VIEW),
  // Their stored moves of the identities listed now: the day's against
  // the trading day before, the month's against the month before. A
  // period's lines of a stock listed now are at most its holders.
  //
  // Decision: Holder moves are derived at parse time
  // (apps/dashboard/docs/adr/0134-holder-moves-are-derived-at-parse-time.md)
  {
    sql: `SELECT stock_code, '5%' AS band, name, move, share_change,
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
    rows: DAY_ROWS + MONTH_ROWS,
  },
  // The month's ≥1% holders that left the above-5% list after the month:
  // each key's newest leaving between the month and the day of an identity
  // that hasn't come back since. An identity starts with the key it was
  // first listed under (lib/holder-identity.ts), so matching it to the
  // month's keys and grouping by that key returns a row per month holder,
  // at most the month's rows, however many identities left under one key
  // (ADR 0133). One renamed since is missed, and shows its move, not Down
  // out of 5%.
  //
  // Decision: the Holder map matches holders across stocks and reports by
  // holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
  {
    sql: `SELECT stock_code, holder_key, MAX(data_date) AS data_date FROM (
      SELECT stock_code, substr(holder, 1, instr(holder, '#') - 1)
          AS holder_key,
        move, data_date,
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
    WHERE nth = 1 AND move = 'off list'
    GROUP BY stock_code, holder_key`,
    rows: MONTH_ROWS,
  },
  // The day before's blocks of each key with several blocks on the day or
  // on the day before, and their securities accounts: such a key moves by
  // its blocks summed on both days (`dayMove`). One day's, at most its
  // rows.
  //
  // Decision: the Holder map matches holders across stocks and reports by
  // holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
  {
    sql: `SELECT h.stock_code, h.data_date, h.no, h.issuer_name,
      h.holder_name, h.holder_key, h.scripless, h.percentage_hundredths
    ${BEFORE_SEVERAL}
    ORDER BY h.stock_code, h.no`,
    rows: DAY_ROWS,
  },
  {
    sql: `SELECT a.stock_code, a.data_date, a.no, a.custodian,
      a.account_name, a.origin, a.domicile, a.scripless
    FROM above_5_account AS a
    JOIN (SELECT h.stock_code, h.data_date, h.no ${BEFORE_SEVERAL}) AS b
      ON b.stock_code = a.stock_code AND b.data_date = a.data_date
        AND b.no = a.no
    ORDER BY a.stock_code, a.no, a.ordinal`,
    rows: DAY_ROWS,
  },
  // The stocks in view first listed on the day, whose holders Holder moves
  // compares with no day: at most the day's blocks.
  {
    sql: `SELECT DISTINCT stock_code FROM above_5_holder AS h
    WHERE ${STOCKS_IN_VIEW} AND data_date = (SELECT day FROM asof)
      AND NOT EXISTS (
        SELECT 1 FROM above_5_holder AS earlier
        WHERE earlier.stock_code = h.stock_code
          AND earlier.data_date < h.data_date
      )`,
    rows: DAY_ROWS,
  },
]

const DayRow = Schema.Struct({ data_date: WibDate })

const FirstListedRow = Schema.Struct({ stock_code: StockCode })

const MostHeldRow = Schema.Struct({
  stock_code: StockCode,
  issuer_name: Schema.String,
  holders: Schema.Number,
})

// The landing view's stocks most held.
//
// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
const MOST_HELD_SQL = {
  sql: `${PERIODS}
  SELECT stock_code, MAX(issuer_name) AS issuer_name,
    COUNT(DISTINCT holder_key) AS holders
  FROM above_1_holding WHERE data_date = (SELECT month FROM band_month)
  GROUP BY stock_code
  ORDER BY holders DESC, stock_code
  LIMIT ${MOST_HELD}`,
  rows: MOST_HELD,
} satisfies Budgeted

// The as-of picker's days: the newest that fit a day's rows at the cap,
// over 30 years of trading days, oldest first.
//
// Decision: a stock's holders are read from its newest periods that fit a
// row budget (apps/dashboard/docs/adr/0133-a-stocks-holders-are-read-from-its-newest-periods-that-fit-a-row-budget.md)
const DAYS_SQL = {
  sql: `SELECT data_date FROM (
    SELECT data_date FROM above_5_day ORDER BY data_date DESC LIMIT ${DAY_ROWS}
  )
  ORDER BY data_date`,
  rows: DAY_ROWS,
} satisfies Budgeted

const originOf = (origins: ReadonlyArray<SplitOrigin | undefined>) =>
  Effect.sync((): HolderMapLink["origin"] => {
    const set = new Set(origins.filter((origin) => origin !== undefined))
    if (set.size > 1) return "mixed"
    return [...set][0]
  })

// One stock's rows of the day and the month, and of the day before its
// keys of several blocks'.
export interface StockRows {
  readonly holders: Array<typeof Above5MapRow.Type>
  readonly accounts: Array<typeof Above5AccountMapRow.Type>
  readonly month: Array<typeof Above1MapRow.Type>
  readonly holdersBefore: Array<typeof Above5MapRow.Type>
  readonly accountsBefore: Array<typeof Above5AccountMapRow.Type>
}

// The rows of each stock in view, by code, in the order read.
export const byStock = (read: {
  readonly [K in keyof StockRows]: ReadonlyArray<StockRows[K][number]>
}) =>
  Effect.sync(() => {
    const stocks = new Map<StockCode, StockRows>()
    const of = (code: StockCode) => {
      const known = stocks.get(code)
      if (known !== undefined) return known
      const rows: StockRows = {
        holders: [],
        accounts: [],
        month: [],
        holdersBefore: [],
        accountsBefore: [],
      }
      stocks.set(code, rows)
      return rows
    }
    for (const row of read.holders) of(row.stock_code).holders.push(row)
    for (const row of read.accounts) of(row.stock_code).accounts.push(row)
    for (const row of read.month) of(row.stock_code).month.push(row)
    for (const row of read.holdersBefore)
      of(row.stock_code).holdersBefore.push(row)
    for (const row of read.accountsBefore)
      of(row.stock_code).accountsBefore.push(row)
    return stocks
  })

// A stock's links: its above-5% holders of the day, repeats folded, then
// the month's ≥1% holders whose key none of the day's blocks carries, each
// summed by key (`holder-map-holders.ts`). The search lists holders by
// these links too, so it offers no key the map folds away.
//
// Decision: the Holder map matches holders across stocks and reports by
// holder key (apps/dashboard/docs/adr/0142-holder-map-matches-holders-across-stocks-and-reports-by-holder-key.md)
export const stockLinks = Effect.fnUntraced(function* (
  code: StockCode,
  day: WibDate | undefined,
  month: WibDate | undefined,
  rows: StockRows
) {
  const above5 =
    day === undefined
      ? []
      : yield* listedHolders(code, day, rows.holders, rows.accounts)
  const dayBefore = rows.holdersBefore[0]?.data_date
  const before =
    dayBefore === undefined
      ? []
      : yield* listedHolders(
          code,
          WibDate.make(dayBefore),
          rows.holdersBefore,
          rows.accountsBefore
        )
  const above1 =
    month === undefined ? [] : yield* monthHolders(code, month, rows.month)
  const typeOf = new Map(above1.map(({ key, sum }) => [key, sum.type]))
  const inAbove5 = new Set(
    rows.holders.map(({ holder_key }) => HolderKey.make(holder_key))
  )
  const links: Array<StockLink> = []
  for (const { key, sum } of above5)
    links.push({
      code,
      band: "5%",
      holder: key,
      name: sum.name,
      percentageHundredths: sum.hundredths,
      shares: sum.shares,
      origin: yield* originOf(sum.origins),
      investorType: typeOf.get(key),
    })
  for (const { key, sum } of above1) {
    if (inAbove5.has(key)) continue
    links.push({
      code,
      band: "1%",
      holder: key,
      name: sum.name,
      percentageHundredths: sum.hundredths,
      shares: sum.shares,
      origin: yield* originOf(sum.origins),
      investorType: sum.type,
    })
  }
  return {
    links,
    // Each 5%-band holder of the day, and of the day before of a key of
    // several blocks, repeats collapsed, by key.
    now: new Map(above5.map((holder) => [holder.key, holder])),
    before: new Map(before.map((holder) => [holder.key, holder])),
    inMonth: new Map(above1.map(({ key, sum }) => [key, sum.hundredths])),
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
    crossingRows = [],
    holderBeforeRows = [],
    accountBeforeRows = [],
    firstListedRows = [],
  ] = rest
  const stocks = yield* byStock({
    holders: yield* decodeRows(Above5MapRow)(holderRows),
    accounts: yield* decodeRows(Above5AccountMapRow)(accountRows),
    month: yield* decodeRows(Above1MapRow)(monthRows),
    holdersBefore: yield* decodeRows(Above5MapRow)(holderBeforeRows),
    accountsBefore: yield* decodeRows(Above5AccountMapRow)(accountBeforeRows),
  })
  const firstListed = new Set(
    (yield* decodeRows(FirstListedRow)(firstListedRows)).map(
      ({ stock_code }) => stock_code
    )
  )
  const moves = yield* storedMoves(yield* decodeRows(MoveRow)(moveRows))
  const down = yield* crossingsDown(
    yield* decodeRows(CrossingRow)(crossingRows)
  )
  const links: Array<HolderMapLink> = []
  const accounts: Array<HoldingAccounts> = []
  const issuers = new Map<StockCode, string>()
  const folded = new Map<HolderKey, { key: HolderKey; hundredths: number }>()
  for (const [code, rows] of stocks) {
    const issuer = rows.holders[0]?.issuer_name ?? rows.month[0]?.issuer_name
    if (issuer !== undefined) issuers.set(code, issuer)
    const {
      links: stockOf,
      now,
      before,
      inMonth,
    } = yield* stockLinks(code, periods.day, periods.month, rows)
    for (const [holder, { sum }] of now) {
      accounts.push({ code, holder, accounts: sum.accounts })
      for (const alias of sum.aliases) {
        const known = folded.get(alias)
        if (known === undefined || sum.hundredths > known.hundredths)
          folded.set(alias, { key: holder, hundredths: sum.hundredths })
      }
    }
    links.push(
      ...(yield* changesOf(
        periods,
        {
          links: stockOf,
          day: { now, before, compared: !firstListed.has(code) },
          inMonth,
        },
        moves,
        down
      ))
    )
  }
  return {
    links,
    issuers,
    custodians: yield* custodianLinks(accounts),
    // Each key whose repeat blocks folded into another key's block of the
    // day: that key, the largest of them where several.
    folded: new Map([...folded].map(([alias, { key }]) => [alias, key])),
  }
})

// The places of `links`.
const placesOf = Effect.fnUntraced(function* (
  links: Iterable<{ readonly code: StockCode; readonly holder: HolderKey }>
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
  if (focus === undefined) return [{ ...MOST_HELD_SQL, params: [asked] }]
  const params = [asked, yield* focusParam(focus, spellings)]
  return [
    ...IN_VIEW_ROWS.map(({ sql, rows }) => ({
      sql: `${IN_VIEW[focus.kind]} ${sql}`,
      params,
      rows,
    })),
    ...OFF_LIST[focus.kind].map((statement) => ({ ...statement, params })),
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
      { ...PERIODS_SQL, params: [asked] },
      { ...DAYS_SQL, params: [] },
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
      offListCut: false,
      mostHeld: yield* mostHeldOf(rest[0] ?? []),
    })
  const { links, issuers, custodians, folded } = yield* linksInView(
    { day: shownDay, month },
    rest.slice(0, IN_VIEW_ROWS.length)
  )
  // A holder focus on a key the day lists only as repeats of another key's
  // blocks, so holding nothing as itself, is that key's: the map reads it,
  // and the page puts its key in the URL.
  const into =
    focus.kind === "holder" && !links.some(({ holder }) => holder === focus.key)
      ? folded.get(focus.key)
      : undefined
  if (into !== undefined)
    return yield* holderMapRead({ focus: { kind: "holder", key: into }, day })
  const { first, second } = yield* hopsOf(focus, links, custodians)
  const offRead = yield* offListRead(focus, rest.slice(IN_VIEW_ROWS.length))
  const offListCut = offRead.cut
  const offList = yield* offListOf(focus, first, offRead.leavings)
  for (const [code, issuer] of offRead.issuers)
    if (!issuers.has(code)) issuers.set(code, issuer)
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
    offListCut,
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
