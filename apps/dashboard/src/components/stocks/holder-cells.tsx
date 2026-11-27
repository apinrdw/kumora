// What Major holders, Daily holders and Holder moves show alike: the
// ownership bar, the move chip, a change of a % or of lots under its figure,
// a broker chip, a trend's bars, and the link to the stock's Holder map.
import { Link } from "@tanstack/react-router"
import type { BrokerCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { kFocus } from "@/components/k/styles"
import { KTooltip } from "@/components/k/tooltip"
import { MOVEMENT } from "@/components/stocks/holder-movement"
import { type MoveKind, TREND_PERIODS } from "@/domain/holdings"
import type { Transfer } from "@/lib/daily-holders"
import type { HolderMapSearch } from "@/lib/holder-map-search"
import type { Move, TrendCell } from "@/lib/holder-identity"
import { lotsOfShares, MINUS, plain } from "@/lib/format"

/** 4110 → `41.10%` */
export const percentOf = (hundredths: number) =>
  Effect.map(plain(hundredths / 100, 2), (text) => `${text}%`)

const signOf = (n: number) => Effect.succeed(n > 0 ? "+" : n < 0 ? MINUS : "±")

/** 10 → `+0.10%`, 0 → `±0.00%` */
export const percentChangeText = Effect.fnUntraced(function* (
  hundredths: number
) {
  return `${yield* signOf(hundredths)}${yield* percentOf(Math.abs(hundredths))}`
})

/** 10,000,000 shares → `+100,000` lots */
export const lotsChangeText = Effect.fnUntraced(function* (shares: number) {
  return `${yield* signOf(shares)}${yield* lotsOfShares(Math.abs(shares))}`
})

export const changeTone = (value: number) =>
  Effect.succeed(
    value > 0 ? "text-up" : value < 0 ? "text-down" : "text-muted-foreground"
  )

// The % from which IDX lists a holder: the daily above-5% report's, or the
// monthly above-1% report's.
export const THRESHOLDS = {
  daily: "5%",
  monthly: "1%",
} as const satisfies Record<MoveKind, string>

// Off list's tooltip on Daily holders and Holder moves.
export const offListText = (kind: MoveKind) =>
  Effect.succeed(
    `Sold out or fell below ${THRESHOLDS[kind]}; the report can't tell which`
  )

// One side of a stake: its %, or `under 5%` where the holder isn't listed.
export const stakeSideText = (hundredths: number | undefined, kind: MoveKind) =>
  hundredths === undefined
    ? Effect.succeed(`under ${THRESHOLDS[kind]}`)
    : percentOf(hundredths)

/** `{ before: 510 }` → `5.10% → under 5%` */
export const stakeChangeText = Effect.fnUntraced(function* (
  stake: { readonly before?: number; readonly now?: number },
  kind: MoveKind
) {
  return `${yield* stakeSideText(stake.before, kind)} → ${yield* stakeSideText(stake.now, kind)}`
})

export function Delta({
  value,
  text,
}: {
  value: number | undefined
  text: (value: number) => Effect.Effect<string>
}) {
  if (value === undefined) return null
  return (
    <div className={cn("text-[12px]", Effect.runSync(changeTone(value)))}>
      {Effect.runSync(text(value))}
    </div>
  )
}

// A change in its tone, or a dash without one.
export function Change({
  value,
  text,
}: {
  value: number | undefined
  text: (value: number) => Effect.Effect<string>
}) {
  if (value === undefined) return "—"
  return (
    <span className={Effect.runSync(changeTone(value))}>
      {Effect.runSync(text(value))}
    </span>
  )
}

const CHIP_CLASS =
  "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold whitespace-nowrap"

// Off list's chip is a button, so its tooltip opens on focus too. An earlier
// holder's names the period it has been off the list since.
export function MoveChip({
  move,
  since,
  offListTip,
}: {
  move: Move | undefined
  // The period, as shown.
  since: string | undefined
  offListTip: string
}) {
  if (move === undefined) return null
  const { label, text, chip } = MOVEMENT[move]
  const className = cn(text, chip)
  return move === "off list" ? (
    <KTooltip content={offListTip}>
      <button type="button" className={cn(CHIP_CLASS, kFocus, className)}>
        {since === undefined ? label : `${label} since ${since}`}
      </button>
    </KTooltip>
  ) : (
    <span className={cn(CHIP_CLASS, className)}>{label}</span>
  )
}

export interface BarSegment {
  readonly key: string
  readonly name: string
  readonly hundredths: number
  readonly shares: number
  // A controller or its affiliate.
  readonly gold: boolean
}

// Each tone's shades, stepped per segment so neighbours of one tone part.
const TONES = {
  gold: ["bg-warning", "bg-warning/70", "bg-warning/85", "bg-warning/55"],
  blue: ["bg-info", "bg-info/70", "bg-info/85", "bg-info/55"],
} as const
const UNDER = "bg-neutral/40"
const LEGEND_TOP = 6
// The holders the bar draws a segment each: at most 100 can be above 1%.
// Any after them share one segment.
const BAR_SEGMENTS = 100

// apinrdw/kumora#474's layout B bar: listed shares split among the holders
// in table order, controllers and affiliates gold, then the rest of the 100%
// as Under the listing threshold. Published percentages can sum past 100%:
// the rest is then none, and the bar splits that sum instead.
export function OwnershipBar({
  segments: lines,
  threshold,
  restShares,
  controllers,
}: {
  segments: ReadonlyArray<BarSegment>
  // The % below which a holder isn't listed: `1%` or `5%`.
  threshold: string
  // The rest's shares, when the listed shares are known.
  restShares?: number | undefined
  // Whether to explain gold in the legend.
  controllers: boolean
}) {
  const segments = lines.slice(0, BAR_SEGMENTS).map((line, index) => {
    const tone = line.gold ? "gold" : "blue"
    return {
      line,
      tone,
      className: TONES[tone][index % TONES[tone].length],
      percent: Effect.runSync(percentOf(line.hundredths)),
      lots: Effect.runSync(lotsOfShares(line.shares)),
    }
  })
  const total = lines.reduce((sum, { hundredths }) => sum + hundredths, 0)
  const under = Math.max(0, 10_000 - total)
  const whole = Math.max(10_000, total)
  const underPercent = Effect.runSync(percentOf(under))
  const restLots =
    restShares === undefined || restShares < 0
      ? ""
      : ` · ${Effect.runSync(lotsOfShares(restShares))} lots`
  const more = lines.length - LEGEND_TOP
  const merged = lines
    .slice(BAR_SEGMENTS)
    .reduce((sum, { hundredths }) => sum + hundredths, 0)
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label="Ownership of listed shares"
        className="flex h-6 overflow-hidden rounded-md"
      >
        {segments.map(({ line, tone, className, percent, lots }) => (
          <div
            key={line.key}
            title={`${line.name} ${percent} · ${lots} lots`}
            data-tone={tone}
            style={{ width: `${(100 * line.hundredths) / whole}%` }}
            className={cn("border-surface min-w-px border-r", className)}
          />
        ))}
        {lines.length > BAR_SEGMENTS && (
          <div
            title={`${lines.length - BAR_SEGMENTS} more holders ${Effect.runSync(percentOf(merged))}`}
            data-tone="more"
            style={{ width: `${(100 * merged) / whole}%` }}
            className={TONES.blue[0]}
          />
        )}
        <div
          title={`Holders under ${threshold} ${underPercent}${restLots}`}
          data-tone="under"
          style={{ width: `${(100 * under) / whole}%` }}
          className={UNDER}
        />
      </div>
      <ul
        aria-label="Ownership legend"
        className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-muted-foreground"
      >
        {segments.slice(0, LEGEND_TOP).map(({ line, className, percent }) => (
          <li key={line.key} className="whitespace-nowrap">
            <Swatch className={className} />
            <span
              className="inline-block max-w-60 truncate align-bottom"
              title={line.name}
            >
              {line.name}
            </span>{" "}
            {percent}
          </li>
        ))}
        {more > 0 && <li>+{more} more</li>}
        <li className="whitespace-nowrap">
          <Swatch className={UNDER} />
          Under {threshold} {underPercent}
        </li>
        {controllers && (
          <li className="whitespace-nowrap">
            <Swatch className={TONES.gold[0]} />
            Gold = controller or affiliate
          </li>
        )}
      </ul>
    </div>
  )
}

function Swatch({ className }: { className: string }) {
  return (
    <i
      aria-hidden
      className={cn(
        "mr-1.5 inline-block size-2.5 rounded-xs align-[-1px]",
        className
      )}
    />
  )
}

type Brokers = ReadonlyArray<BrokerCode | "custodian">

// A move's Through: a Transfer's brokers its shares left, then those they
// reached; else the brokers of the accounts whose shares changed.
export function ThroughChips({
  through,
  transfer,
}: {
  through: Brokers
  transfer: Transfer<BrokerCode | "custodian"> | undefined
}) {
  const chips = (side: Brokers) =>
    side.map((broker) => <BrokerChip key={broker} broker={broker} />)
  return (
    <div className="flex flex-wrap items-center gap-1">
      {transfer === undefined ? (
        chips(through)
      ) : (
        <>
          {chips(transfer.from)}
          <span aria-label="to" className="text-[11px] text-muted-foreground">
            →
          </span>
          {chips(transfer.to)}
        </>
      )}
    </div>
  )
}

// A move's change in lots; a Transfer's lots moved, unsigned and untoned:
// moved, not bought or sold.
export function LotsChange({
  shareChange,
  transfer,
}: {
  shareChange: number | undefined
  transfer: Transfer<unknown> | undefined
}) {
  return transfer === undefined ? (
    <Change value={shareChange} text={lotsChangeText} />
  ) : (
    Effect.runSync(lotsOfShares(transfer.shares))
  )
}

// The Holder map focused on a stock (spec apinrdw/kumora#733, "Links in").
export function HolderMapLink({ search }: { search: HolderMapSearch }) {
  return (
    <Link
      to="/holder-map"
      search={search}
      aria-label={`Holder map of ${search.stock}`}
      className={cn("text-info rounded-xs text-[12px] hover:underline", kFocus)}
    >
      Holder map
    </Link>
  )
}

// A broker code, or Custodian for an account at a bank or other custodian
// that is not an exchange member.
export function BrokerChip({ broker }: { broker: BrokerCode | "custodian" }) {
  return (
    <span
      data-chip
      className={cn(
        "rounded-xs border border-border px-1 text-[11px] leading-4 font-semibold whitespace-nowrap",
        broker === "custodian" ? "text-muted-foreground" : "num text-foreground"
      )}
    >
      {broker === "custodian" ? "Custodian" : broker}
    </span>
  )
}

const TREND_WIDTH = 160
const TREND_HEIGHT = 26

// One bar per period (a trading day or a month), the selected one last and
// shaded: a change in shares up or down from the midline on a square-root
// scale, a full bar where the holder entered (blue) or left (grey) the list,
// a tick on the midline where its shares moved between brokers.
export function Trend({
  cells,
  name,
  periods,
}: {
  cells: ReadonlyArray<TrendCell>
  name: string
  // What a bar is, plural: "trading days", "months".
  periods: string
}) {
  const slot = TREND_WIDTH / TREND_PERIODS
  const offset = TREND_PERIODS - cells.length
  const middle = TREND_HEIGHT / 2
  const largest = Math.max(
    1,
    ...cells.map((cell) =>
      typeof cell === "number" ? Math.sqrt(Math.abs(cell)) : 0
    )
  )
  return (
    <svg
      width={TREND_WIDTH}
      height={TREND_HEIGHT}
      viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
      role="img"
      aria-label={`${name}: change in lots on each of the last ${cells.length} ${periods}`}
      className="ml-auto block"
    >
      <line
        x1={0}
        x2={TREND_WIDTH}
        y1={middle}
        y2={middle}
        className="stroke-border"
        strokeDasharray="2 2"
      />
      {cells.map((cell, index) => {
        if (cell === null || cell === 0) return null
        const x = (offset + index) * slot + 1
        const width = Math.max(slot - 2, 1.4)
        if (cell === "transfer")
          return (
            <rect
              key={index}
              data-cell={cell}
              x={x}
              y={middle - 2}
              width={width}
              height={4}
              className="fill-muted-foreground"
            />
          )
        if (typeof cell === "string")
          return (
            <rect
              key={index}
              data-cell={cell}
              x={x}
              y={1}
              width={width}
              height={TREND_HEIGHT - 2}
              opacity={0.8}
              className={cell === "in" ? "fill-info" : "fill-neutral"}
            />
          )
        const height = Math.max(
          2.5,
          (Math.sqrt(Math.abs(cell)) / largest) * (middle - 1)
        )
        return (
          <rect
            key={index}
            data-cell={cell > 0 ? "up" : "down"}
            x={x}
            y={cell > 0 ? middle - height : middle}
            width={width}
            height={height}
            className={cell > 0 ? "fill-up" : "fill-down"}
          />
        )
      })}
      <rect
        x={(TREND_PERIODS - 1) * slot}
        y={0}
        width={slot}
        height={TREND_HEIGHT}
        className="fill-foreground"
        opacity={0.1}
      />
    </svg>
  )
}
