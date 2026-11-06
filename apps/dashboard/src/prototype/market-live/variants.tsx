// PROTOTYPE, throwaway: three structurally different Market Live layouts on one fake relay.
import { IconSearch } from "@tabler/icons-react"
import { cn } from "@workspace/ui/lib/utils"
import { useEffect, useMemo, useRef, useState } from "react"

import { Delta, KStatusPill } from "@/components/k"
import { plain } from "@/lib/format"
import { FEED, STOCKS, hms, useTape } from "./fake-feed"
import type { Trade } from "./fake-feed"
import { LwChart, LwNotice } from "./lw-chart"

export type VariantProps = { code: string; onCode: (code: string) => void }

// ---------- shared bits (small on purpose; layouts stay independent) ----------

function FeedPills({ className }: { className?: string }) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [])
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <span className="text-[11px] text-muted-foreground">Stockbit</span>
      <KStatusPill status={FEED.state.stockbit} />
      <span className="ml-1 text-[11px] text-muted-foreground">Ajaib</span>
      <KStatusPill status={FEED.state.ajaib} />
    </div>
  )
}

function useQuote(code: string) {
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 500)
    return () => clearInterval(id)
  }, [])
  const stock = STOCKS.find((s) => s.code === code)!
  const last = FEED.last(code)
  return {
    stock,
    last,
    changePct: ((last - stock.prevClose) / stock.prevClose) * 100,
  }
}

function ProvenanceDots({ trade }: { trade: Trade }) {
  return (
    <span className="flex gap-0.5" title={`Dari: ${trade.feeds.join(" + ")}`}>
      <i
        className={cn(
          "size-1.5 rounded-full",
          trade.feeds.includes("stockbit") ? "bg-info" : "bg-border"
        )}
      />
      <i
        className={cn(
          "size-1.5 rounded-full",
          trade.feeds.includes("ajaib") ? "bg-warning" : "bg-border"
        )}
      />
    </span>
  )
}

function CodeSearch({
  onPick,
  focusOnMount,
  className,
}: {
  onPick: (code: string) => void
  focusOnMount?: boolean
  className?: string
}) {
  const [q, setQ] = useState("")
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (focusOnMount) input.current?.focus()
  }, [focusOnMount])
  const hits = useMemo(() => {
    const s = q.trim().toUpperCase()
    return STOCKS.filter(
      (x) => !s || x.code.startsWith(s) || x.name.toUpperCase().includes(s)
    ).slice(0, 8)
  }, [q])
  return (
    <div className={cn("relative", className)}>
      <label className="bg-surface flex h-9 items-center gap-2 rounded-md border border-input px-2.5">
        <IconSearch className="size-4 text-muted-foreground" />
        <input
          ref={input}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) {
              onPick(hits[0].code)
              setQ("")
              setOpen(false)
            }
          }}
          placeholder="Cari kode saham…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </label>
      {open && hits.length > 0 && (
        <ul className="bg-elevated absolute z-20 mt-1 w-full rounded-md border border-border py-1 shadow-[var(--shadow-popover)]">
          {hits.map((h) => (
            <li key={h.code}>
              <button
                type="button"
                onMouseDown={() => {
                  onPick(h.code)
                  setQ("")
                }}
                className="hover:bg-selected flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left"
              >
                <b className="w-12 text-sm">{h.code}</b>
                <span className="truncate text-xs text-muted-foreground">
                  {h.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TapeTable({
  code,
  trades,
  wide,
  dimOthers,
}: {
  code: string
  trades: ReadonlyArray<Trade>
  wide?: boolean
  dimOthers?: boolean
}) {
  return (
    <table className="num w-full text-[12px]">
      <thead className="bg-surface sticky top-0 text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
        <tr className="h-7 text-right">
          <th className="pl-3 text-left font-medium">Waktu</th>
          <th className="text-left font-medium">Kode</th>
          <th className="font-medium">Harga</th>
          <th className="font-medium">Lot</th>
          {wide && <th className="font-medium">Nilai</th>}
          <th className="pr-3 font-medium">{wide ? "Sisi · Sumber" : "B/S"}</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => {
          const mine = t.code === code
          return (
            <tr
              key={t.tradeNumber}
              className={cn(
                "h-6 text-right",
                mine && "bg-selected",
                !mine && dimOthers && "text-muted-foreground"
              )}
            >
              <td className="pl-3 text-left text-muted-foreground">
                {hms(t.time)}
              </td>
              <td
                className={cn(
                  "text-left",
                  mine ? "font-bold text-primary" : "font-semibold"
                )}
              >
                {t.code}
              </td>
              <td>{plain(t.price)}</td>
              <td>{plain(t.lots)}</td>
              {wide && (
                <td className="text-muted-foreground">
                  {compact(t.price * t.lots * 100)}
                </td>
              )}
              <td className="pr-3">
                <span className="inline-flex items-center justify-end gap-2">
                  <b className={t.side === "B" ? "text-up" : "text-down"}>
                    {t.side}
                  </b>
                  {wide && <ProvenanceDots trade={t} />}
                </span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function compact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(".", ",") + " M"
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(".", ",") + " jt"
  return plain(n)
}

// ---------- A: Terminal split ----------

export function VariantA({ code, onCode }: VariantProps) {
  const q = useQuote(code)
  const trades = useTape(5)
  return (
    <div className="grid gap-4 lg:h-[calc(100svh-7.5rem)] lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="bg-surface flex min-h-0 flex-col rounded-lg border border-border">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border p-3">
          <CodeSearch onPick={onCode} className="w-56" />
          <div className="flex items-baseline gap-2">
            <b className="text-xl">{code}</b>
            <span className="num text-xl font-semibold">{plain(q.last)}</span>
            <Delta value={q.changePct} />
          </div>
          <span className="hidden truncate text-xs text-muted-foreground xl:block">
            {q.stock.name}
          </span>
          <FeedPills className="ml-auto" />
        </header>
        <LwChart code={code} className="h-[420px] min-h-0 flex-1 p-2" />
        <footer className="border-t border-border px-3 py-1.5">
          <LwNotice />
        </footer>
      </section>
      <section className="bg-surface flex min-h-0 flex-col rounded-lg border border-border">
        <header className="flex h-10 items-center justify-between border-b border-border px-3">
          <h2 className="text-sm font-semibold">
            Running trade · seluruh pasar
          </h2>
          <span className="text-[11px] text-muted-foreground">
            {code} disorot
          </span>
        </header>
        <div className="h-[420px] min-h-0 flex-1 overflow-y-auto lg:h-auto">
          <TapeTable code={code} trades={trades} />
        </div>
      </section>
    </div>
  )
}

// ---------- B: Tape-first with a watchlist selector ----------

export function VariantB({ code, onCode }: VariantProps) {
  const trades = useTape(5)
  const q = useQuote(code)
  const [filter, setFilter] = useState("")
  const list = STOCKS.filter((s) => s.code.includes(filter.toUpperCase()))
  return (
    <div className="grid gap-3 lg:h-[calc(100svh-7.5rem)] lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="bg-surface flex min-h-0 flex-col rounded-lg border border-border">
        <div className="border-b border-border p-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Saring kode…"
            className="bg-canvas h-8 w-full rounded-md border border-input px-2 text-sm outline-none"
          />
        </div>
        <ul className="flex max-h-48 min-h-0 flex-1 overflow-x-auto lg:max-h-none lg:flex-col lg:overflow-y-auto">
          {list.map((s) => (
            <WatchRow
              key={s.code}
              code={s.code}
              selected={s.code === code}
              onPick={onCode}
            />
          ))}
        </ul>
      </aside>
      <div className="flex min-h-0 flex-col gap-3">
        <section className="bg-surface rounded-lg border border-border">
          <header className="flex items-center gap-3 px-3 pt-2">
            <b>{code}</b>
            <span className="num font-semibold">{plain(q.last)}</span>
            <Delta value={q.changePct} />
            <span className="text-[11px] text-muted-foreground">1 menit</span>
            <FeedPills className="ml-auto" />
          </header>
          <LwChart code={code} className="h-[240px]" />
          <div className="px-3 pb-1.5">
            <LwNotice />
          </div>
        </section>
        <section className="bg-surface flex min-h-0 flex-1 flex-col rounded-lg border border-border">
          <header className="flex h-10 items-center gap-3 border-b border-border px-3">
            <h2 className="text-sm font-semibold">
              Running trade · seluruh pasar
            </h2>
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <i className="bg-info size-1.5 rounded-full" /> Stockbit
              <i className="bg-warning ml-2 size-1.5 rounded-full" /> Ajaib
            </span>
          </header>
          <div className="h-[480px] min-h-0 flex-1 overflow-y-auto lg:h-auto">
            <TapeTable code={code} trades={trades} wide dimOthers />
          </div>
        </section>
      </div>
    </div>
  )
}

function WatchRow({
  code,
  selected,
  onPick,
}: {
  code: string
  selected: boolean
  onPick: (code: string) => void
}) {
  const q = useQuote(code)
  return (
    <li className="shrink-0">
      <button
        type="button"
        onClick={() => onPick(code)}
        className={cn(
          "num hover:bg-elevated flex h-9 w-full items-center gap-2 px-3 text-left text-[13px]",
          selected && "bg-selected shadow-[inset_2px_0_0_var(--accent-primary)]"
        )}
      >
        <b className="w-12">{code}</b>
        <span className="ml-auto">{plain(q.last)}</span>
        <Delta value={q.changePct} className="w-16 justify-end text-[11px]" />
      </button>
    </li>
  )
}

// ---------- C: Chart-first, command-palette selector, tape strip ----------

export function VariantC({ code, onCode }: VariantProps) {
  const q = useQuote(code)
  const trades = useTape(8)
  const [palette, setPalette] = useState(false)
  const [drawer, setDrawer] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest("input,textarea,[contenteditable]")) return
      if (e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        setPalette(true)
      }
      if (e.key === "Escape") setPalette(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  return (
    <div className="bg-surface relative flex flex-col gap-0 overflow-hidden rounded-lg border border-border lg:h-[calc(100svh-7.5rem)]">
      <div className="relative min-h-[420px] flex-1">
        <LwChart code={code} className="absolute inset-0" />
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="bg-canvas/80 hover:bg-elevated absolute top-3 left-3 z-10 rounded-md px-3 py-2 text-left backdrop-blur"
        >
          <div className="flex items-baseline gap-3">
            <b className="text-3xl tracking-tight">{code}</b>
            <span className="num text-2xl font-semibold">{plain(q.last)}</span>
            <Delta value={q.changePct} />
          </div>
          <div className="text-[11px] text-muted-foreground">
            {q.stock.name} · 1 menit · tekan{" "}
            <kbd className="rounded border border-border px-1">/</kbd> untuk
            ganti
          </div>
        </button>
        <FeedPills className="bg-canvas/80 absolute top-3 right-20 z-10 rounded-md px-2 py-1 backdrop-blur" />
      </div>
      <TapeStrip
        code={code}
        trades={trades}
        onToggle={() => setDrawer((d) => !d)}
        open={drawer}
      />
      {drawer && (
        <div className="max-h-[38vh] overflow-y-auto border-t border-border">
          <TapeTable code={code} trades={trades} wide />
        </div>
      )}
      <div className="border-t border-border px-3 py-1">
        <LwNotice />
      </div>
      {palette && (
        <div className="fixed inset-0 z-40 flex items-start justify-center pt-[15vh]">
          <button
            type="button"
            aria-label="Tutup"
            onClick={() => setPalette(false)}
            className="absolute inset-0 bg-black/50"
          />
          <div className="bg-elevated w-full max-w-md rounded-lg border border-border p-3 shadow-[var(--shadow-modal)]">
            <CodeSearch
              focusOnMount
              onPick={(c) => {
                onCode(c)
                setPalette(false)
              }}
            />
            <p className="mt-2 text-[11px] text-muted-foreground">
              Enter memilih hasil pertama · Esc menutup
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function TapeStrip({
  code,
  trades,
  onToggle,
  open,
}: {
  code: string
  trades: ReadonlyArray<Trade>
  onToggle: () => void
  open: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div className="bg-canvas flex h-11 items-center border-t border-border">
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-elevated h-full shrink-0 border-r border-border px-3 text-[11px] font-semibold tracking-[0.08em] uppercase"
      >
        Running trade {open ? "▾" : "▴"}
      </button>
      <div
        ref={ref}
        className="num flex min-w-0 flex-1 gap-4 overflow-hidden px-3 text-[12px] whitespace-nowrap"
      >
        {trades.slice(0, 40).map((t) => (
          <span
            key={t.tradeNumber}
            className={cn(
              "flex gap-1.5",
              t.code === code && "bg-selected rounded px-1.5"
            )}
          >
            <b className={t.code === code ? "text-primary" : undefined}>
              {t.code}
            </b>
            <span className={t.side === "B" ? "text-up" : "text-down"}>
              {plain(t.price)}
            </span>
            <span className="text-muted-foreground">×{plain(t.lots)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
