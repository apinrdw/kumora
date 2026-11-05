import { Link, useNavigate } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"
import { useEffect, useMemo, useRef, useState } from "react"
import type { FormEvent } from "react"

import {
  Delta,
  KChip,
  KEmptyState,
  KInput,
  KStatusPill,
  kToast,
} from "@/components/k"
import { isSymbol } from "@/domain/symbol-guard"
import { LIVE_PAGE_PATH, LIVE_PAGE_SEARCH } from "@/relay/routes"
import type { Symbol } from "@/domain/symbol"
import type { LiveSymbol, WhalesToday } from "@/domain/trade"
import { thresholdLine, wib } from "./whale-format"
import { pct, plain } from "@/lib/format"

import { GAP_ALPHA, PROFILE_ALPHA } from "./chart-layers"
import { chartSlots } from "./chart-slots"
import { LiveChart } from "./live-chart"
import {
  CANDLE_PERIODS,
  DEFAULT_PERIOD,
  EVENT_FILTERS,
  cumulativeNet,
  eventCounts,
  filterEvents,
  newToasts,
  signedLots,
  signedMoney,
  symbolChips,
  whaleEvents,
} from "./live-model"
import type { CandlePeriod, EventFilter, WhaleEvent } from "./live-model"
import { useLiveSymbol } from "./live-symbol"
import type { LiveSymbolState } from "./live-symbol"
import { useWhales } from "./whales"
import type { WhalesState } from "./whales"
import { OffBoardList, RawTape } from "./trade-tables"

/** Rows a feed draws at a time: a first day can hold thousands. */
const FEED_PAGE = 200

function SymbolSearch({ selected }: { selected: Symbol | null }) {
  const navigate = useNavigate()
  const [text, setText] = useState<string>(selected ?? "")
  const [invalid, setInvalid] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const wanted = text.trim().toUpperCase()
    setInvalid(!isSymbol(wanted))
    if (isSymbol(wanted))
      void navigate({
        to: LIVE_PAGE_PATH,
        search: { [LIVE_PAGE_SEARCH.symbol]: wanted },
      })
  }
  return (
    <form onSubmit={submit} role="search" className="flex items-center gap-2">
      <KInput
        label="Symbol"
        hideLabel
        placeholder="Symbol"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-28 uppercase"
      />
      {invalid && (
        <span role="alert" className="text-down text-xs">
          A symbol is four letters.
        </span>
      )}
    </form>
  )
}

function SymbolChips({
  whales,
  selected,
}: {
  whales: WhalesState
  selected: Symbol | null
}) {
  const chips = symbolChips(whales.leaderboard, selected)
  if (chips.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No sweeps this session yet.
      </p>
    )
  return (
    <ul aria-label="Symbols with sweeps" className="flex flex-wrap gap-1.5">
      {chips.map(({ symbol, net }) => (
        <li key={symbol}>
          <Link
            to={LIVE_PAGE_PATH}
            search={{ [LIVE_PAGE_SEARCH.symbol]: symbol }}
            aria-current={symbol === selected ? "true" : undefined}
            className={cn(
              "num hover:bg-elevated inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs",
              symbol === selected && "bg-selected border-primary"
            )}
          >
            <b className="font-[650]">{symbol}</b>
            {net !== null && (
              <span className={net >= 0 ? "text-up" : "text-down"}>
                {signedMoney(net)}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  )
}

function EventRow({ event }: { event: WhaleEvent }) {
  const buying = event.type === "Sweep Buy" || event.type === "Bid Wall"
  return (
    <li className="grid grid-cols-[64px_minmax(0,1fr)_72px_64px] gap-x-2 border-t border-border py-2 text-xs">
      <time className="num text-muted-foreground">{wib(event.at)}</time>
      <div className="min-w-0">
        <b className={cn("font-[650]", buying ? "text-up" : "text-down")}>
          {event.type}
        </b>
        {event.live && (
          <span className="text-warning ml-2 text-[10px]">live</span>
        )}
        <p className="mt-0.5 leading-[18px] text-muted-foreground">
          {event.detail}
        </p>
      </div>
      <span className="num text-right font-[650]">{event.lots}</span>
      <span className="num text-right">{event.value}</span>
    </li>
  )
}

function EventFeed({ state }: { state: LiveSymbolState }) {
  const { sweeps, walls, wallCoverage } = state.tape
  const [filter, setFilter] = useState<EventFilter>("All")
  const [shown, setShown] = useState(FEED_PAGE)
  const events = whaleEvents(sweeps, walls)
  const counts = eventCounts(events)
  const rows = filterEvents(events, filter)
  return (
    <section aria-label="Whale events" className="flex min-h-0 flex-col gap-2">
      <div
        role="group"
        aria-label="Event type"
        className="flex flex-wrap gap-1.5"
      >
        {EVENT_FILTERS.map((f) => (
          <KChip
            key={f}
            selected={f === filter}
            onSelectedChange={() => setFilter(f)}
            count={counts[f]}
          >
            {f}
          </KChip>
        ))}
      </div>
      {!wallCoverage && (
        <p className="text-xs text-muted-foreground">Walls not watched</p>
      )}
      {rows.length === 0 ? (
        <KEmptyState
          kind="no-data"
          title="No events"
          description="A sweep or a wall on this symbol appears here as it happens."
          className="max-w-none"
        />
      ) : (
        <>
          <div className="grid grid-cols-[64px_minmax(0,1fr)_72px_64px] gap-x-2 text-[11px] text-muted-foreground">
            <span>Time</span>
            <span>Type · Detail</span>
            <span className="text-right">Lots</span>
            <span className="text-right">Value</span>
          </div>
          <ol className="max-h-[620px] overflow-y-auto">
            {rows.slice(0, shown).map((event) => (
              <EventRow key={event.key} event={event} />
            ))}
          </ol>
          {rows.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + FEED_PAGE)}
              className="text-xs text-muted-foreground underline underline-offset-2"
            >
              Show more ({plain(rows.length - shown)})
            </button>
          )}
        </>
      )}
    </section>
  )
}

function PeriodPicker({
  period,
  onChange,
}: {
  period: CandlePeriod
  onChange: (period: CandlePeriod) => void
}) {
  return (
    <div role="group" aria-label="Candle period" className="flex gap-1">
      {CANDLE_PERIODS.map((p) => (
        <KChip
          key={p.label}
          selected={p.label === period.label}
          onSelectedChange={() => onChange(p)}
        >
          {p.label}
        </KChip>
      ))}
    </div>
  )
}

function Quote({ state, symbol }: { state: LiveSymbolState; symbol: Symbol }) {
  const { last, prev } = state.tape.quote
  const change = last !== null && prev !== null ? last - prev : null
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-lg font-bold">{symbol}</span>
      <span className="num text-lg font-bold">
        {last === null ? "—" : plain(last)}
      </span>
      <Delta
        value={change}
        display={
          change === null || !prev
            ? "—"
            : `${plain(Math.abs(change))} (${pct((change / prev) * 100)})`
        }
      />
    </div>
  )
}

/** Sweeps that closed and walls that appeared on this symbol, as they happen. */
const useEventToasts = ({ sweeps, walls }: LiveSymbolState["tape"]) => {
  const before = useRef({ sweeps, walls })
  useEffect(() => {
    const after = { sweeps, walls }
    for (const text of newToasts(before.current, after, Date.now()))
      kToast.info(text)
    before.current = after
  }, [sweeps, walls])
}

/** Often enough that a quiet minute's slot opens in it. */
const SLOT_TICK_MS = 15_000

/** The time, a little behind, so the chart's slots run on while no trade arrives. */
const useNow = () => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SLOT_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

function ChartKey() {
  const swatch = (color: string, opacity: number) => (
    <span
      aria-hidden
      className={cn("inline-block size-2 rounded-xs", color)}
      style={{ opacity }}
    />
  )
  return (
    <p className="text-[11px] leading-4 text-muted-foreground">
      <span className="mr-3 inline-flex items-center gap-1">
        Profile, session lots by price: {swatch("bg-up", PROFILE_ALPHA)} buy{" "}
        {swatch("bg-down", PROFILE_ALPHA)} sell{" "}
        {swatch("bg-neutral", PROFILE_ALPHA)} unspecified
      </span>
      <span className="mr-3 inline-flex items-center gap-1">
        {swatch("bg-warning", GAP_ALPHA)} no source: trades unseen
      </span>
      Volume is regular board only, from the relay&apos;s tape, and can
      undercount: a dropped trade is not recovered.
    </p>
  )
}

const offBoardNote = (n: number) => {
  if (n === 0) return ""
  return n === 1
    ? " 1 off-board trade is listed below."
    : ` ${plain(n)} off-board trades are listed below.`
}

function SymbolPane({ symbol, live }: { symbol: Symbol; live: LiveSymbol }) {
  const state = useLiveSymbol(symbol, live)
  const { tape, candles, coverage } = state
  const [period, setPeriod] = useState(DEFAULT_PERIOD)
  const now = useNow()
  const slots = useMemo(
    () =>
      chartSlots({
        day: tape.day,
        minutes: candles.candles,
        coverage,
        periodMs: period.ms,
        nowMs: now,
      }),
    [tape.day, candles.candles, coverage, period, now]
  )
  useEventToasts(tape)
  return (
    <div className="grid items-start gap-4 min-[1440px]:grid-cols-[minmax(0,1fr)_460px]">
      {/* scripts/drive-extension.mts reads the quote summary by this label. */}
      <section
        aria-label="Candles"
        className="bg-surface flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Quote state={state} symbol={symbol} />
          <PeriodPicker period={period} onChange={setPeriod} />
          <span className="flex items-center gap-2 sm:ml-auto">
            <KStatusPill
              status={tape.provenance.freshness}
              {...(tape.provenance.asOf ? { asOf: tape.provenance.asOf } : {})}
            />
            <span className="text-[11px] text-muted-foreground">trades</span>
            <KStatusPill
              status={tape.liveprice.freshness}
              {...(tape.liveprice.asOf ? { asOf: tape.liveprice.asOf } : {})}
            />
            <span className="text-[11px] text-muted-foreground">liveprice</span>
          </span>
        </div>
        <p className="num text-[11px] text-muted-foreground">
          {thresholdLine(tape.threshold)} · net sweep lots, cumulative{" "}
          <b className="text-foreground">
            {signedLots(cumulativeNet(tape.sweeps))}
          </b>
        </p>
        {candles.candles.length === 0 ? (
          <KEmptyState
            kind="no-data"
            title={`No regular-board trades on ${symbol} this session`}
            description={`Candles build from the relay's tape as trades arrive.${offBoardNote(tape.offBoard.length)}`}
            className="max-w-none"
          />
        ) : null}
        {/* Laid out while empty, not display: none, so the chart fits at its real width. */}
        <div
          aria-hidden={candles.candles.length === 0 || undefined}
          className={
            candles.candles.length === 0 ? "h-0 overflow-hidden" : undefined
          }
        >
          <LiveChart
            slots={slots}
            profile={candles.profile}
            sweeps={tape.sweeps}
            walls={tape.walls}
            period={period}
          />
          <ChartKey />
        </div>
        <RawTape trades={tape.trades} />
      </section>
      <div className="bg-surface flex flex-col gap-3 rounded-lg border border-border p-3">
        <EventFeed state={state} />
        <OffBoardList trades={tape.offBoard} />
      </div>
    </div>
  )
}

/** Held once: moving between symbols must not reopen the market's socket. */
function useMarket(today: WhalesToday) {
  const [first] = useState(today)
  return useWhales(first).state
}

export function LiveRadarPage({
  today,
  symbol,
  live,
}: {
  today: WhalesToday
  symbol: Symbol | null
  live: LiveSymbol | null
}) {
  const whales = useMarket(today)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-2xl leading-8 font-bold">Whale Radar Live</h1>
        <SymbolSearch key={symbol} selected={symbol} />
        <span className="num ml-auto text-xs text-muted-foreground">
          {whales.day ? `Last session · ${whales.day}` : "No session yet"}
        </span>
      </div>
      <SymbolChips whales={whales} selected={symbol} />
      {symbol !== null && live !== null ? (
        <SymbolPane key={symbol} symbol={symbol} live={live} />
      ) : (
        <KEmptyState
          kind="no-data"
          title="No sweeps this session yet"
          description="Search a symbol, or wait for the first order to reach its whale threshold."
          className="max-w-none"
        />
      )}
    </div>
  )
}
