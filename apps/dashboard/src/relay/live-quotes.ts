// Each symbol's Quote as the object holds it: the newest RG trade, rebuilt by
// load(), and the `liveprice` totals, read back from `live_quote` on first use. A
// write lost to a restart is corrected by the next frame.
import type { Symbol } from "@/domain/symbol"
import type { IsoDateTime } from "@/domain/time"
import type { LiveQuote } from "@/domain/trade"

import { foldLivePrice, quoteOf, shouldWriteQuote } from "./quote"
import type { LastRg, LiveTotals } from "./quote"
import type { RelayStore } from "./store"
import type { RawLivePrice } from "./stockbit"

/** A symbol's totals, ahead of its `live_quote` row by up to 30 s. */
type HeldQuote = {
  totals: LiveTotals
  writtenAt: number | null
  dirty: boolean
}

export type ServedQuote = {
  readonly quote: LiveQuote
  readonly asOf: IsoDateTime | null
}

const asOfOf = (rg: LastRg | null, totals: LiveTotals | null) =>
  totals?.asOf ?? rg?.receivedAt ?? null

export class LiveQuotes {
  private rg = new Map<Symbol, LastRg>()
  private held = new Map<Symbol, HeldQuote>()

  constructor(private readonly store: RelayStore) {}

  setRg(symbol: Symbol, rg: LastRg) {
    this.rg.set(symbol, rg)
  }

  clear() {
    this.rg.clear()
    this.held.clear()
  }

  /** The only read of a symbol's quote. Null when the relay has nothing of `day` for it. */
  served(symbol: Symbol, day: string | null): ServedQuote | null {
    const rg = this.rg.get(symbol) ?? null
    const totals = this.totalsOf(symbol, day)
    if (rg === null && totals === null) return null
    return { quote: quoteOf(rg, totals), asOf: asOfOf(rg, totals) }
  }

  /** True when the frame changed the figures, so the symbol's pages need them. */
  fold(
    symbol: Symbol,
    raw: RawLivePrice,
    day: string | null,
    now: number
  ): boolean {
    const held = this.heldQuote(symbol)
    const fold = foldLivePrice(
      held?.totals ?? null,
      raw,
      day,
      new Date(now).toISOString() as IsoDateTime
    )
    if (fold === null) return false
    // A stamp alone still reaches the row, or a wake forgets the order it set.
    if (!fold.changed && fold.totals.sourceAt === held?.totals.sourceAt)
      return false
    const next: HeldQuote = {
      totals: fold.totals,
      writtenAt: held?.writtenAt ?? null,
      dirty: true,
    }
    this.held.set(symbol, next)
    if (shouldWriteQuote(now, next.writtenAt)) this.write(symbol, next, now)
    return fold.changed
  }

  /** What a symbol's last frame left would otherwise wait for a next one that may not come. */
  flush(now: number) {
    for (const [symbol, held] of this.held)
      if (held.dirty && shouldWriteQuote(now, held.writtenAt))
        this.write(symbol, held, now)
  }

  private totalsOf(symbol: Symbol, day: string | null): LiveTotals | null {
    const totals = this.heldQuote(symbol)?.totals
    return totals?.day === day ? totals : null
  }

  private heldQuote(symbol: Symbol): HeldQuote | null {
    const known = this.held.get(symbol)
    if (known) return known
    const stored = this.store.storedQuote(symbol)
    if (!stored) return null
    const held: HeldQuote = { ...stored, dirty: false }
    this.held.set(symbol, held)
    return held
  }

  private write(symbol: Symbol, held: HeldQuote, now: number) {
    this.store.writeQuote(symbol, { totals: held.totals, writtenAt: now })
    held.writtenAt = now
    held.dirty = false
  }
}
