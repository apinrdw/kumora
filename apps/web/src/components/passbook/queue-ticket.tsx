import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import type { Copy } from "@/lib/copy"
import { queueNumber, wibClock } from "@/lib/format"

export type Ticket = {
  readonly number: number
  readonly joinedAt: number
  readonly status: "joined" | "already"
}

/** The bank queue ticket the slip prints once an email joins. */
export function QueueTicket({
  ticket,
  copy,
  fresh,
}: {
  ticket: Ticket
  copy: Copy
  /** Animate it out of the machine; false when restored on a later visit. */
  fresh: boolean
}) {
  return (
    <div
      role="status"
      className={cn(
        "text-ink relative flex w-full max-w-[22rem] flex-col gap-2 bg-[#fbfcf9] px-5 pt-4 pb-5 shadow-[0_10px_24px_-12px_rgb(19_44_92/0.55)]",
        // The perforated top edge of a ticket torn from the machine's roll.
        "before:absolute before:inset-x-0 before:-top-[5px] before:h-[10px] before:bg-[radial-gradient(circle_at_6px_5px,var(--paper)_4px,transparent_4.5px)] before:bg-[length:12px_10px] before:bg-repeat-x",
        fresh &&
          "animate-[ticket-out_700ms_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:animate-none"
      )}
    >
      <div className="border-rule flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-dashed pb-2">
        <span className="text-[13px] font-[750] tracking-[0.08em] uppercase [font-stretch:80%]">
          {copy.ticketTitle}
        </span>
        <span className="print text-ink-soft whitespace-nowrap">
          {copy.ticketTaken} {Effect.runSync(wibClock(ticket.joinedAt))}
        </span>
      </div>
      <div className="print py-1 text-center [font-size:64px] leading-[1] font-[900] tracking-[0.04em]">
        {Effect.runSync(queueNumber(ticket.number))}
      </div>
      <p className="text-ink-soft text-[14px] leading-[1.45]">
        {ticket.status === "joined" ? copy.ticketJoined : copy.ticketAlready}
      </p>
    </div>
  )
}
