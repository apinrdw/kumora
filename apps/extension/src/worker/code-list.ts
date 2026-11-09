// Ajaib's stock code list as the relay holds it (spec apinrdw/kumora#138,
// "Stock code list"): fetched from the Ajaib tab once a WIB day, kept for the
// Stockbit subscribe and for a target's fresh socket.
import {
  EncodedIngestUp,
  IngestProtocolVersion,
  StockCode,
  WibDate,
  encodeIngestUp,
  wibDateAt,
} from "@workspace/relay"
import { DateTime, Duration, Effect, Option, PubSub, Schema } from "effect"

import { CODE_LIST_PATH, listedCodes } from "./ajaib.ts"
import type { BrokerTab } from "./tab.ts"

// The day's list with the CodeList envelope it went up as, so a worker that
// restarts needs no second fetch and a target that connects later in the day
// gets the same envelope.
export const CodeListCache = Schema.Struct({
  date: WibDate,
  codes: Schema.Array(StockCode),
  envelope: EncodedIngestUp,
})
export type CodeListCache = typeof CodeListCache.Type

// Where the held list lives across worker restarts: chrome.storage.local
// (settings.ts).
export interface CodeListStore {
  readonly load: Effect.Effect<Option.Option<CodeListCache>>
  readonly save: (list: CodeListCache) => Effect.Effect<void>
}

// Decision: the code list is fetched from the Ajaib tab once a WIB day, and
// retried at most once a minute until it answers. See apinrdw/kumora#138.
const CODE_LIST_RETRY = Duration.minutes(1)

export const makeCodeList = Effect.fnUntraced(function* (options: {
  readonly store: CodeListStore
  readonly envelopes: PubSub.PubSub<EncodedIngestUp>
  // Runs when the list changed: the Stockbit subscribe follows it.
  readonly changed: Effect.Effect<void>
}) {
  let list = yield* options.store.load
  let lastTry = 0
  let fetching = false

  const fetchList = Effect.fnUntraced(function* (
    tab: Pick<BrokerTab, "request">,
    today: WibDate
  ) {
    const answer = yield* tab.request({
      _tag: "page-fetch",
      path: CODE_LIST_PATH,
    })
    if (Option.isNone(answer) || answer.value.status !== 200) return
    const codes = yield* listedCodes(answer.value.body)
    if (codes.length === 0) return
    const envelope = yield* Effect.orDie(
      encodeIngestUp({
        _tag: "CodeList",
        protocolVersion: IngestProtocolVersion,
        receivedAt: yield* DateTime.now,
        body: answer.value.body,
      })
    )
    const held = { date: today, codes, envelope }
    list = Option.some(held)
    yield* options.store.save(held)
    yield* PubSub.publish(options.envelopes, envelope)
    yield* options.changed
  })

  // On a tick: fetch today's list unless it's held, one try at a time.
  const tick = Effect.fnUntraced(function* (
    tab: Pick<BrokerTab, "request" | "attached">,
    now: DateTime.Utc
  ) {
    const today = yield* wibDateAt(now)
    const ms = DateTime.toEpochMillis(now)
    if (Option.isSome(list) && list.value.date === today) return
    if (fetching || !(yield* tab.attached)) return
    if (ms - lastTry < Duration.toMillis(CODE_LIST_RETRY)) return
    lastTry = ms
    fetching = true
    yield* Effect.forkScoped(
      Effect.ensuring(
        fetchList(tab, today),
        Effect.sync(() => {
          fetching = false
        })
      )
    )
  })

  // The CodeList envelope of `day`, for a target's fresh socket of that day;
  // none while the list held is an earlier day's, which the Stockbit
  // subscribe still uses until the day's fetch answers.
  const catchUp = (day: WibDate) =>
    Effect.sync(() =>
      Option.match(list, {
        onNone: () => [],
        onSome: (held) => (held.date === day ? [held.envelope] : []),
      })
    )

  return {
    tick,
    catchUp,
    codes: () =>
      Option.match(list, { onNone: () => [], onSome: (held) => held.codes }),
  }
})
