// Vitest's stand-in for cloudflare:workers. The relay stub serves an empty tape;
// a suite that cares about the tape provides `Tape` itself.
import type { Symbol } from "@/domain/symbol"

const provenance = {
  feed: "stockbit-running-trades",
  source: "none",
  asOf: null,
  freshness: "stale",
}

/** The real class's base: `TradeRelay` reads only these two. */
export class DurableObject<E = unknown> {
  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: E
  ) {}
}

/** The real class's base: `OwnershipLoad` reads only `env`. */
export class WorkflowEntrypoint<E = unknown> {
  constructor(
    protected readonly ctx: ExecutionContext,
    protected readonly env: E
  ) {}
}

export const env = {
  RELAY_TICKET_SECRET: "test-ticket-secret",
  TRADE_RELAY: {
    getByName: () => ({
      backfill: async (symbol: Symbol) => ({
        symbol,
        seq: 0,
        day: null,
        trades: [],
        quote: {},
        coverage: [],
        provenance,
      }),
      today: async () => ({
        seq: 0,
        day: null,
        sweeps: [],
        sweepsTotal: 0,
        leaderboard: [],
        walls: [],
        wallCoverage: [],
        thresholds: { symbols: 0, warmingUp: 0 },
        provenance,
        liveprice: { ...provenance, feed: "stockbit-liveprice" },
      }),
      earlier: async () => [],
    }),
  },
}
