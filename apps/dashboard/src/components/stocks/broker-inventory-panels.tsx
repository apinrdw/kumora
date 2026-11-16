// The Broker inventory chart's side panels (apinrdw/kumora#421, "Amended
// 2026-11-16"): the hovered or pinned day's figures, and the drag
// selection's. Each date opens that recorded day in Market Live.
import type { BrokerCode, StockCode, WibDate } from "@workspace/relay"
import { Link } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import type { ReactNode } from "react"

import { KButton } from "@/components/k/button"
import { kFocus } from "@/components/k/styles"
import { averageCell, netCell } from "@/components/stocks/broker-summary"
import type {
  HoverDay,
  Measure,
  SelectionSummary,
} from "@/lib/broker-inventory"
import { count, dayLabel, pct, price } from "@/lib/format"

const tableClass =
  "w-full text-[12px] whitespace-nowrap [&_td]:py-0.5 [&_td]:pl-2 [&_td]:text-right [&_th]:py-0.5 [&_th]:pl-2 [&_th]:text-right [&_th]:font-medium [&_th]:text-muted-foreground [&_th:first-child]:pl-0 [&_th:first-child]:text-left"

const tone = (net: number) => cn(net > 0 && "text-up", net < 0 && "text-down")

// A day, as a link to its recorded day in Market Live.
function DayLink({ code, day }: { code: StockCode; day: WibDate }) {
  const label = Effect.runSync(dayLabel(day))
  return (
    <Link
      to="/market-live"
      search={{ code, day }}
      aria-label={`Open ${label} in Market Live`}
      title="Open in Market Live"
      className={cn("font-semibold underline-offset-2 hover:underline", kFocus)}
    >
      {label}
    </Link>
  )
}

function BrokerCell({
  broker,
  color,
}: {
  broker: BrokerCode
  color: string | undefined
}) {
  return (
    <th scope="row" className="font-sans">
      <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
        <span
          aria-hidden
          style={{ background: color }}
          className="size-2 rounded-full"
        />
        {broker}
      </span>
    </th>
  )
}

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      {children}
    </section>
  )
}

export function HoverDayPanel({
  code,
  hover,
  pinned,
  measure,
  colors,
}: {
  code: StockCode
  hover: HoverDay
  pinned: boolean
  measure: Measure
  colors: ReadonlyMap<BrokerCode, string>
}) {
  return (
    <Panel label="Day">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
        <DayLink code={code} day={hover.day} />
        <span className="text-muted-foreground">
          Close{" "}
          <span className="num text-foreground">
            {hover.close === undefined
              ? "–"
              : Effect.runSync(price(hover.close))}
          </span>
        </span>
      </div>
      <table aria-label="Day figures" className={tableClass}>
        <thead>
          <tr>
            <th scope="col">Broker</th>
            <th scope="col">Net</th>
            <th scope="col">Day</th>
            <th scope="col">Avg buy</th>
            <th scope="col">Avg sell</th>
          </tr>
        </thead>
        <tbody className="num">
          {hover.rows.map((row) => (
            <tr key={row.broker}>
              <BrokerCell broker={row.broker} color={colors.get(row.broker)} />
              <td className={tone(row.net)}>
                {Effect.runSync(netCell(row.net, measure))}
              </td>
              <td className={tone(row.dayNet)}>
                {Effect.runSync(netCell(row.dayNet, measure))}
              </td>
              <td>{Effect.runSync(averageCell(row.avgBuy))}</td>
              <td>{Effect.runSync(averageCell(row.avgSell))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">
        {pinned
          ? "Pinned · Esc or a click on the chart unpins"
          : "Click the chart to pin a day · drag to select days"}
      </p>
    </Panel>
  )
}

export function SelectionPanel({
  code,
  selection,
  measure,
  colors,
  onClear,
}: {
  code: StockCode
  selection: SelectionSummary
  measure: Measure
  colors: ReadonlyMap<BrokerCode, string>
  onClear: () => void
}) {
  const { total } = selection
  return (
    <Panel label="Selection">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Selection</h3>
        <KButton variant="ghost" size="sm" onClick={onClear}>
          Clear
        </KButton>
      </div>
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
        <DayLink code={code} day={selection.from} />
        {selection.to !== selection.from && (
          <>
            <span aria-hidden>–</span>
            <DayLink code={code} day={selection.to} />
          </>
        )}
      </p>
      <p className="text-[12px] text-muted-foreground">
        {Effect.runSync(count(selection.days, "day", "days"))} · price{" "}
        <span className={cn("num", tone(selection.change ?? 0))}>
          {selection.change === undefined
            ? "–"
            : Effect.runSync(pct(selection.change))}
        </span>
      </p>
      <table aria-label="Selection figures" className={tableClass}>
        <thead>
          <tr>
            <th scope="col">Broker</th>
            <th scope="col">Net</th>
            <th scope="col">Avg buy</th>
            <th scope="col">Avg sell</th>
          </tr>
        </thead>
        <tbody className="num">
          {selection.rows.map((row) => (
            <tr key={row.broker}>
              <BrokerCell broker={row.broker} color={colors.get(row.broker)} />
              <td className={tone(row.net)}>
                {Effect.runSync(netCell(row.net, measure))}
              </td>
              <td>{Effect.runSync(averageCell(row.avgBuy))}</td>
              <td>{Effect.runSync(averageCell(row.avgSell))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="num border-t border-border">
          <tr>
            <th scope="row" className="font-sans">
              Total
            </th>
            <td className={tone(total.net)}>
              {Effect.runSync(netCell(total.net, measure))}
            </td>
            <td>{Effect.runSync(averageCell(total.avgBuy))}</td>
            <td>{Effect.runSync(averageCell(total.avgSell))}</td>
          </tr>
        </tfoot>
      </table>
    </Panel>
  )
}
