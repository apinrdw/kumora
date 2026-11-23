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
import {
  DateTime,
  Duration,
  Effect,
  type Fiber,
  Option,
  PubSub,
  Schema,
} from "effect"

import { CODE_LIST_PATH, listedCodes } from "./ajaib.ts"
import type { PacedTab } from "./pacer.ts"
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

// What the options page's relay button did: a fresh list fetched and sent
// up; Ajaib missed and today's held list sent again; Ajaib missed and none of
// today's is held; or a fetch was already under way.
export const RelayOutcome = Schema.Literals([
  "fetched",
  "resent",
  "missed",
  "busy",
])
export type RelayOutcome = typeof RelayOutcome.Type

// The code list is fetched from the Ajaib tab once a WIB day, and
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
  let lastUnattached = 0
  let fetching = false

  const fetchList = Effect.fnUntraced(function* (
    tab: PacedTab,
    today: WibDate
  ) {
    const answer = yield* tab.request({
      _tag: "page-fetch",
      path: CODE_LIST_PATH,
    })
    // Each miss is logged: the page's search and watchlist wait on this list,
    // and the next try is a minute away.
    // None also when the Ajaib page made no REST call yet and no PIN token
    // is held: the tab sends nothing then.
    if (Option.isNone(answer)) {
      yield* Effect.logWarning(
        "Code list fetch got no answer: the Ajaib tab has no session yet, or went"
      )
      return false
    }
    if (answer.value.status !== 200) {
      yield* Effect.logWarning(
        `Code list fetch answered ${answer.value.status}`
      )
      return false
    }
    const codes = yield* listedCodes(answer.value.body)
    if (codes.length === 0) {
      yield* Effect.logWarning(
        "Code list answer held no codes",
        answer.value.body.slice(0, 200)
      )
      return false
    }
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
    return true
  })

  // One fetch at a time; a defect is logged and counts as a miss.
  const fetchOnce = (tab: PacedTab, today: WibDate) => {
    fetching = true
    return fetchList(tab, today).pipe(
      Effect.catchCause((cause) =>
        Effect.as(Effect.logError("Code list fetch failed", cause), false)
      ),
      Effect.ensuring(
        Effect.sync(() => {
          fetching = false
        })
      )
    )
  }

  // On a tick: fetch today's list unless it's held, one try at a time. The
  // fetch is forked, since the tab's answer comes in as a worker event; the
  // tick gives its fiber, none when it fetched nothing.
  const tick = Effect.fnUntraced(function* (
    tab: PacedTab & Pick<BrokerTab, "attached">,
    now: DateTime.Utc
  ) {
    const none = Option.none<Fiber.Fiber<boolean>>()
    const today = yield* wibDateAt(now)
    const ms = DateTime.toEpochMillis(now)
    if (Option.isSome(list) && list.value.date === today) return none
    if (fetching) return none
    if (!(yield* tab.attached)) {
      if (ms - lastUnattached < Duration.toMillis(CODE_LIST_RETRY)) return none
      lastUnattached = ms
      yield* Effect.logWarning("Code list waits for an open Ajaib tab")
      return none
    }
    if (ms - lastTry < Duration.toMillis(CODE_LIST_RETRY)) return none
    lastTry = ms
    return Option.some(yield* Effect.forkScoped(fetchOnce(tab, today)))
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

  // The options page's relay button: today's list fetched now, held or not,
  // and sent up; when Ajaib misses, today's held list is sent again. Either
  // reaches the targets open now, and a target that's down gets it on its
  // next socket. Forked, as the tick's fetch is: the tab's answer comes in
  // as a worker event. `report` hears the outcome.
  const relayNow = Effect.fnUntraced(function* (
    tab: PacedTab,
    now: DateTime.Utc,
    report: (outcome: RelayOutcome) => Effect.Effect<void>
  ) {
    if (fetching) return yield* report("busy")
    const today = yield* wibDateAt(now)
    lastTry = DateTime.toEpochMillis(now)
    // Called before the fork, so a tick in between sees the fetch.
    const fetched = fetchOnce(tab, today)
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        if (yield* fetched) return yield* report("fetched")
        const held = yield* catchUp(today)
        yield* PubSub.publishAll(options.envelopes, held)
        yield* report(held.length > 0 ? "resent" : "missed")
      })
    )
  })

  // The codes held, today's or an earlier day's: the Stockbit subscribe.
  const codes = Effect.sync(() =>
    Option.match(list, { onNone: () => [], onSome: (held) => held.codes })
  )

  return { tick, relayNow, catchUp, codes }
})
