import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import type { Copy, Lang } from "@/lib/copy"
import { rupiahBillions, signed } from "@/lib/format"

import { SLICE } from "./recorded-slice"

type Balance = {
  readonly broker: string
  readonly type: "F" | "D"
  readonly lots: number
  readonly rupiah: number
}

// Each broker's buys minus sells over the slice, by investor type, largest
// buyers first. A broker trading for both types counts once per type.
const balances = Effect.fnUntraced(function* () {
  const by = new Map<string, { -readonly [K in keyof Balance]: Balance[K] }>()
  const add = (
    broker: string,
    type: "F" | "D",
    lots: number,
    rupiah: number
  ) => {
    const key = `${broker}${type}`
    const b = by.get(key) ?? { broker, type, lots: 0, rupiah: 0 }
    b.lots += lots
    b.rupiah += rupiah
    by.set(key, b)
  }
  for (const [, price, lots, , buyer, bt, seller, st] of SLICE) {
    const rupiah = price * lots * 100
    add(buyer, bt, lots, rupiah)
    add(seller, st, -lots, -rupiah)
  }
  return [...by.values()].sort((a, b) => b.lots - a.lots)
})

// The three biggest buyers and the five biggest sellers: the rest net close
// to zero over twelve seconds.
const SHOWN_BUYERS = 3
const SHOWN_SELLERS = 5

/** The saldo page: who ended the twelve seconds holding more, and who less. */
export function Saldo({ copy, lang }: { copy: Copy; lang: Lang }) {
  const all = Effect.runSync(balances())
  const rows = [...all.slice(0, SHOWN_BUYERS), ...all.slice(-SHOWN_SELLERS)]
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-14">
      <div className="flex flex-col gap-4">
        <h2 className="text-ink text-[clamp(1.75rem,3.2vw,2.6rem)] leading-[1.06] font-[800] tracking-[-0.015em] text-balance [font-stretch:108%]">
          {copy.saldoHeading}
        </h2>
        <p className="text-ink-soft max-w-[52ch] text-[17px] leading-[1.6]">
          {copy.saldoBody}
        </p>
      </div>
      <figure className="flex min-w-0 flex-col gap-3">
        <div className="overflow-x-auto">
          <table className="print text-ink w-full min-w-[19rem] border-collapse max-[420px]:text-[13px]">
            <thead>
              <tr className="border-cloth/60 text-cloth border-b-2 font-sans text-[11px] leading-[16px] font-[750] tracking-[0.12em] uppercase [font-stretch:78%] [&>th]:pb-1.5">
                <th scope="col" className="text-left">
                  {copy.colBroker}
                </th>
                <th
                  scope="col"
                  className="border-cloth/25 border-l pr-1 text-right"
                >
                  {copy.colNet}
                </th>
                <th
                  scope="col"
                  className="border-cloth/25 border-l pr-1 text-right"
                >
                  {copy.colValue}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b, i) => (
                <tr
                  key={`${b.broker}${b.type}`}
                  className={cn(
                    "border-rule border-b border-dashed",
                    i === SHOWN_BUYERS && "border-t-ink/70 border-t-2",
                    i === 0 && "double-strike"
                  )}
                >
                  <td className="py-0.5 whitespace-nowrap">
                    {b.broker} [{b.type}]
                    {i === 0 && (
                      <span className="stamp ml-3 align-middle">
                        {copy.netBuyer}
                      </span>
                    )}
                  </td>
                  <td className="border-cloth/25 border-l pr-1 text-right whitespace-nowrap">
                    {Effect.runSync(signed(b.lots, lang))}
                  </td>
                  <td className="border-cloth/25 border-l pr-1 text-right whitespace-nowrap">
                    {b.rupiah < 0 ? "−" : "+"}
                    {Effect.runSync(rupiahBillions(Math.abs(b.rupiah), lang))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <figcaption className="text-ink-soft max-w-[60ch] text-[13px] leading-[1.5]">
          {copy.saldoCaption}
        </figcaption>
      </figure>
    </div>
  )
}
