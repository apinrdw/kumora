// The Broker inventory tab's Broker summary (spec apinrdw/kumora#437,
// "Broker summary"; prototype variant B): every broker that traded the code
// in the range, by net, with a swatch on each plotted one. A row's click
// adds or removes its single-broker chip.
import type { BrokerCode } from "@workspace/relay"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { kFocus } from "@/components/k/styles"
import type { Measure, SummaryFooter, SummaryRow } from "@/lib/broker-inventory"
import { compact, compactIdr, count, lots, plain, sign } from "@/lib/format"

/** +1,250 lots or −Rp1.23 B */
const netCell = Effect.fnUntraced(function* (net: number, measure: Measure) {
  return measure === "lots"
    ? (yield* sign(net)) + (yield* lots(Math.abs(net)))
    : yield* compactIdr(net)
})

const averageCell = (average: number | undefined) =>
  average === undefined ? Effect.succeed("–") : plain(average)

// The footer's line: what the figures cover.
const footerLine = Effect.fnUntraced(function* (footer: SummaryFooter) {
  return [
    yield* count(footer.brokers, "broker", "brokers"),
    `${yield* compact(footer.lots)} lots traded`,
    "regular board + auction matches",
    `${yield* count(footer.incomplete, "incomplete day", "incomplete days")} skipped`,
  ].join(" · ")
})

export function BrokerSummary({
  rows,
  footer,
  measure,
  colors,
  singles,
  onToggle,
}: {
  rows: ReadonlyArray<SummaryRow>
  footer: SummaryFooter
  measure: Measure
  // Each plotted broker's line colour.
  colors: ReadonlyMap<BrokerCode, string>
  // The brokers with a single-broker chip.
  singles: ReadonlySet<BrokerCode>
  onToggle: (broker: BrokerCode) => void
}) {
  return (
    <section aria-labelledby="broker-summary" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="broker-summary" className="text-[13px] font-semibold">
          Broker summary
        </h3>
        <span className="text-[12px] text-muted-foreground">
          Click a row to add or remove its line
        </span>
      </div>
      <div className="overflow-x-auto">
        <table
          aria-label="Broker summary"
          className="w-full text-[13px] whitespace-nowrap [&_td]:px-2 [&_td]:py-1 [&_td]:text-right [&_th]:px-2 [&_th]:py-1 [&_th]:text-right [&_th]:font-medium [&_th]:text-muted-foreground [&_th:first-child]:text-left [&_tr]:border-b [&_tr]:border-border"
        >
          <thead>
            <tr>
              <th scope="col">Broker</th>
              <th scope="col">Buy lots</th>
              <th scope="col">Avg buy</th>
              <th scope="col">Sell lots</th>
              <th scope="col">Avg sell</th>
              <th scope="col">
                {measure === "lots" ? "Net lots" : "Net value"}
              </th>
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((row) => {
              const color = colors.get(row.broker)
              return (
                <tr
                  key={row.broker}
                  onClick={() => onToggle(row.broker)}
                  className="hover:bg-elevated cursor-pointer"
                >
                  <th scope="row" className="font-sans">
                    <button
                      type="button"
                      aria-pressed={singles.has(row.broker)}
                      className={cn(
                        "inline-flex items-center gap-1.5",
                        color !== undefined && "font-semibold",
                        kFocus
                      )}
                    >
                      <span
                        aria-hidden
                        style={{ background: color }}
                        className={cn(
                          "size-2 rounded-[2px]",
                          color === undefined && "border border-border"
                        )}
                      />
                      {row.broker}
                      <span className="text-[10px] font-normal text-muted-foreground">
                        {row.investorType}
                      </span>
                    </button>
                  </th>
                  <td>{Effect.runSync(lots(row.buyLots))}</td>
                  <td>{Effect.runSync(averageCell(row.avgBuy))}</td>
                  <td>{Effect.runSync(lots(row.sellLots))}</td>
                  <td>{Effect.runSync(averageCell(row.avgSell))}</td>
                  <td
                    className={cn(
                      row.net > 0 && "text-up",
                      row.net < 0 && "text-down"
                    )}
                  >
                    {Effect.runSync(netCell(row.net, measure))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {Effect.runSync(footerLine(footer))}
      </p>
    </section>
  )
}
