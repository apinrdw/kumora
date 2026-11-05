// The extension gives up on the relay after the same 45 s: `SILENT_MS` in
// apps/stockbit-relay-extension/src/ingest-silence.ts.
const SILENT_MS = 45_000

/** What holds the active role while the own session is live. Ingest ids are UUIDs. */
export const OWN_SESSION = "upstream"

/** An ingest's state: kept in its socket attachment, because the object hibernates. */
export type Ingest = {
  readonly id: string
  readonly connectedAt: number
  readonly datafeed: boolean
  /**
   * The extension install that opened it, from its `datafeed` message. Null until
   * then, and for a writer that sends none.
   */
  readonly install: string | null
}

/**
 * Who holds the active role, given the ingests with an open socket. It moves when
 * the active ingest closes, goes silent, or reports `datafeed: false`, and then to the
 * oldest ingest with a datafeed. It also moves, at once, to the newest ingest with
 * a datafeed from the active ingest's install: one install keeps one ingest, so that is
 * its reconnect, and the active ingest's socket is dead. A stored id with no open socket
 * does not count. While the own session is live it holds the role, and every
 * ingest is paused.
 */
export const selectSource = (
  activeId: string | null,
  ingests: ReadonlyArray<Ingest>,
  ownSessionLive = false
): string | null => {
  if (ownSessionLive) return OWN_SESSION
  const live = ingests.filter((i) => i.datafeed)
  const active = live.find((i) => i.id === activeId)
  if (active) {
    const reconnect = live
      .filter(
        (i) =>
          active.install !== null &&
          i.install === active.install &&
          i.connectedAt > active.connectedAt
      )
      .sort((a, b) => b.connectedAt - a.connectedAt)[0]
    return reconnect?.id ?? active.id
  }
  return live.sort((a, b) => a.connectedAt - b.connectedAt)[0]?.id ?? null
}

/** No ping for 45 s. Before its first ping, an ingest counts from its connect. */
export const ingestIsSilent = (
  now: number,
  lastPingAt: number | null,
  connectedAt: number
): boolean => now - Math.max(lastPingAt ?? 0, connectedAt) > SILENT_MS
