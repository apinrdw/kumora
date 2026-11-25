import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { Fragment, useEffect, useRef, useState } from "react"

import type { Copy, Lang } from "@/lib/copy"
import { count, rupiahBillions, wibTime } from "@/lib/format"

import { SLICE, type SliceRow } from "./recorded-slice"

// Lines kept on the page; older ones scroll off the top as new ones print.
const VISIBLE = 12
// The first frame, server-rendered and shown without motion: the page as it
// stands just after AK's first Rp1 B trade (row 90) has printed.
const FIRST_FRAME = 96
// One line every this many ms: slow enough to read a broker pair.
const LINE_MS = 520
// A trade worth at least Rp1 B (glossary: Big trade). Lots are 100 shares.
const BIG_TRADE_RUPIAH = 1_000_000_000

const valueOf = (row: SliceRow) => Effect.succeed(row[1] * row[2] * 100)

const sideInk = (row: SliceRow) =>
  Effect.succeed(
    row[3] === "b" ? "text-up" : row[3] === "s" ? "text-down" : "text-ink"
  )

// Newest line darkest; older lines fade like a ribbon running dry. The fade
// mixes the ink toward the paper, at most 32%, which keeps every line above
// 4.5:1. Prices keep their side's full ink.
const agedInk = (age: number) =>
  Effect.succeed(
    `color-mix(in srgb, var(--ink) ${100 - Math.min(age * 3, 32)}%, var(--paper))`
  )

// The pre-printed form layer: headers and column rules in the bank's cobalt
// form ink, under the ribbon's entries.
const formHead =
  "font-sans text-[11px] leading-[16px] font-[750] tracking-[0.12em] text-cloth uppercase [font-stretch:78%]"
const columnRule = "border-l border-cloth/25 pl-2"

const reducedMotion = () =>
  Effect.sync(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )

/** The right page: BBRI's recorded trades, printing one line at a time. */
export function Ledger({ copy, lang }: { copy: Copy; lang: Lang }) {
  const [cursor, setCursor] = useState(FIRST_FRAME)
  const [printing, setPrinting] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (Effect.runSync(reducedMotion())) return
    const node = root.current
    let visible = true
    const tick = () => {
      if (!visible || document.hidden) return
      setPrinting(true)
      setCursor((c) => (c + 1 >= SLICE.length ? VISIBLE : c + 1))
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true
    })
    if (node) observer.observe(node)
    const timer = setInterval(tick, LINE_MS)
    return () => {
      clearInterval(timer)
      observer.disconnect()
    }
  }, [])

  const rows = SLICE.slice(Math.max(0, cursor - VISIBLE), cursor)
  const head = rows.at(-1)

  return (
    <div ref={root} className="flex min-w-0 flex-col gap-3">
      <div className="border-rule flex items-center justify-between gap-3 border-b pb-2">
        <h2 className="text-ink text-[15px] font-[750] tracking-[0.06em] uppercase [font-stretch:85%]">
          {copy.ledgerTitle}
        </h2>
        <span className="stamp rotate-[3deg]">{copy.recorded}</span>
      </div>

      <p className="sr-only">{copy.ledgerSummary}</p>

      <div className="-mx-1 overflow-x-auto px-1">
        <table
          aria-label={copy.ledgerTitle}
          className="print text-ink w-full min-w-[21rem] border-collapse max-[420px]:text-[13px]"
        >
          <thead>
            <tr
              className={cn(formHead, "border-cloth/40 border-b [&>th]:pb-1.5")}
            >
              <th scope="col" className="text-left">
                {copy.colTime}
              </th>
              <th scope="col" className={cn(columnRule, "pr-1 text-right")}>
                {copy.colPrice}
              </th>
              <th scope="col" className={cn(columnRule, "pr-1 text-right")}>
                {copy.colLots}
              </th>
              <th scope="col" className={cn(columnRule, "text-left")}>
                {copy.colBuyer}
              </th>
              <th scope="col" className={cn(columnRule, "text-left")}>
                {copy.colSeller}
              </th>
              <th scope="col" className={cn(columnRule, "max-sm:hidden")}>
                <span className="sr-only">{copy.bigTrade}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const age = rows.length - 1 - i
              const newest = age === 0
              const value = Effect.runSync(valueOf(row))
              const big = value >= BIG_TRADE_RUPIAH
              const animate = newest && printing
              const stamp = big && (
                <span
                  className={cn(
                    "stamp",
                    animate &&
                      "animate-[stamp-down_420ms_cubic-bezier(0.16,1,0.3,1)_both]"
                  )}
                >
                  {copy.bigTrade}{" "}
                  <span className="normal-case">
                    {Effect.runSync(rupiahBillions(value, lang))}
                  </span>
                </span>
              )
              return (
                <Fragment key={cursor - age}>
                  <tr
                    style={
                      big ? undefined : { color: Effect.runSync(agedInk(age)) }
                    }
                    className={cn(
                      "border-rule/60 border-b border-dashed",
                      newest && "double-strike",
                      big &&
                        "double-strike bg-ink text-paper [&>td]:text-paper",
                      animate &&
                        "[&>td]:animate-[print-line_340ms_steps(9,end)_both]"
                    )}
                  >
                    <td className="whitespace-nowrap">
                      {Effect.runSync(wibTime(row[0]))}
                    </td>
                    <td
                      className={cn(
                        columnRule,
                        "pr-1 text-right whitespace-nowrap",
                        !big && Effect.runSync(sideInk(row))
                      )}
                    >
                      {Effect.runSync(count(row[1], lang))}
                    </td>
                    <td
                      className={cn(
                        columnRule,
                        "pr-1 text-right whitespace-nowrap"
                      )}
                    >
                      {Effect.runSync(count(row[2], lang))}
                    </td>
                    <td className={cn(columnRule, "whitespace-nowrap")}>
                      {row[4]} [{row[5]}]
                    </td>
                    <td className={cn(columnRule, "whitespace-nowrap")}>
                      {row[6]} [{row[7]}]
                    </td>
                    <td
                      className={cn(
                        columnRule,
                        "w-[9rem] whitespace-nowrap max-sm:hidden"
                      )}
                    >
                      {stamp}
                    </td>
                  </tr>
                  {big && (
                    <tr className="sm:hidden">
                      <td colSpan={5} className="py-1 text-right">
                        {stamp}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {head && (
        <div
          aria-hidden
          className="bg-ink print text-paper relative flex items-center gap-2 overflow-hidden rounded-[2px] px-2 py-1"
        >
          {/* The carriage crosses the line being printed, then lifts away. */}
          <span className="relative flex gap-2">
            {printing && (
              <span
                key={cursor}
                className="bg-paper/80 absolute inset-y-0.5 left-0 w-2 animate-[carriage_340ms_steps(9,end)_both]"
              />
            )}
            <span>{copy.printHead}</span>
            <span>{Effect.runSync(wibTime(head[0]))} WIB</span>
          </span>
          <span className="ml-auto">
            {cursor}/{SLICE.length}
          </span>
        </div>
      )}

      <p className="text-ink-soft max-w-[60ch] text-[13px] leading-[1.5]">
        {copy.ledgerCaption}
      </p>
    </div>
  )
}
