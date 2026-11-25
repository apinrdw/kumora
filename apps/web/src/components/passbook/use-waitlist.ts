import { clientRuntime } from "@workspace/client"
import { loadServerFn } from "@workspace/server/loader"
import { Effect, Fiber, Schema } from "effect"
import { useCallback, useEffect, useState } from "react"

import type { Lang } from "@/lib/copy"
import { joinWaitlist } from "@/server/waitlist/waitlist.functions"

import type { Ticket } from "./queue-ticket"

export type WaitlistState =
  | { readonly _tag: "Idle" }
  // `slip` names the form that sent it, so only that form shows the outcome.
  | { readonly _tag: "Sending"; readonly slip: string }
  | { readonly _tag: "Invalid"; readonly slip: string }
  | { readonly _tag: "Failed"; readonly slip: string }
  // `fresh` is false when the ticket came back from this browser's storage.
  | {
      readonly _tag: "Holding"
      readonly ticket: Ticket
      readonly fresh: boolean
    }

// This browser keeps its own ticket, so a revisit shows the number it took.
const STORAGE_KEY = "kumora.waitlist.ticket"

const StoredTicket = Schema.Struct({
  number: Schema.Int,
  joinedAt: Schema.Number,
  status: Schema.Literals(["joined", "already"]),
})

const readStored = Effect.sync(() => {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}).pipe(
  Effect.flatMap((raw) =>
    raw === null
      ? Effect.succeed(null)
      : Schema.decodeUnknownEffect(Schema.fromJsonString(StoredTicket))(
          raw
        ).pipe(Effect.orElseSucceed(() => null))
  )
)

const store = (ticket: Ticket) =>
  Effect.sync(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ticket))
    } catch {
      // Private windows refuse storage; the ticket still shows this visit.
    }
  })

// A malformed email comes back as the function's only BadRequest; anything
// else (a 500, the network) is a failure the visitor can retry.
const join = (email: string, lang: Lang, slip: string) =>
  loadServerFn(() => joinWaitlist({ data: { email, lang } })).pipe(
    Effect.flatMap((result) => {
      const ticket: Ticket = {
        number: result.number,
        joinedAt: result.joinedAt,
        status: result.status,
      }
      return Effect.as(store(ticket), {
        _tag: "Holding",
        ticket,
        fresh: true,
      } satisfies WaitlistState)
    }),
    Effect.catchTag("BadRequest", () =>
      Effect.succeed<WaitlistState>({ _tag: "Invalid", slip })
    ),
    Effect.catchCause(() =>
      Effect.succeed<WaitlistState>({ _tag: "Failed", slip })
    )
  )

/** One waitlist for the page: both slips share it. */
export function useWaitlist(lang: Lang) {
  const [state, setState] = useState<WaitlistState>({ _tag: "Idle" })

  // The ticket this browser took on an earlier visit, read once storage is
  // reachable (after hydration, so the server and first client render agree).
  useEffect(() => {
    const fiber = clientRuntime.runFork(
      readStored.pipe(
        Effect.tap((stored) =>
          Effect.sync(() => {
            if (stored)
              setState({ _tag: "Holding", ticket: stored, fresh: false })
          })
        )
      )
    )
    return () => {
      clientRuntime.runFork(Fiber.interrupt(fiber))
    }
  }, [])

  const submit = useCallback(
    (email: string, slip: string) => {
      setState({ _tag: "Sending", slip })
      clientRuntime.runFork(
        join(email.trim(), lang, slip).pipe(
          Effect.tap((next) => Effect.sync(() => setState(next)))
        )
      )
    },
    [lang]
  )

  return { state, submit }
}
