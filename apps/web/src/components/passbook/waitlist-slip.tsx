import { useHydrated } from "@tanstack/react-router"
import { formFields } from "@workspace/client"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useId } from "react"
import type { FormEvent } from "react"

import type { Copy } from "@/lib/copy"

import { QueueTicket } from "./queue-ticket"
import type { WaitlistState } from "./use-waitlist"

type SlipView = {
  // This slip sent the request now pending or just answered.
  readonly sending: boolean
  readonly invalid: boolean
  readonly error: string | null
}

// What one slip shows of the shared waitlist state: another slip's sending
// disables this one too, but its outcome shows only where it was sent from.
const viewOf = (state: WaitlistState, slip: string, copy: Copy) =>
  Effect.succeed<SlipView>(
    state._tag === "Idle" || state._tag === "Holding" || state.slip !== slip
      ? { sending: false, invalid: false, error: null }
      : {
          sending: state._tag === "Sending",
          invalid: state._tag === "Invalid",
          error:
            state._tag === "Invalid"
              ? copy.errorInvalid
              : state._tag === "Failed"
                ? copy.errorServer
                : null,
        }
  )

/** The printed waitlist form, or the queue ticket once the email is in. */
export function WaitlistSlip({
  copy,
  state,
  onSubmit,
  className,
}: {
  copy: Copy
  state: WaitlistState
  onSubmit: (email: string, slip: string) => void
  className?: string
}) {
  if (state._tag === "Holding") {
    return (
      <div className={className}>
        <QueueTicket ticket={state.ticket} copy={copy} fresh={state.fresh} />
      </div>
    )
  }
  return (
    <SlipForm
      copy={copy}
      state={state}
      onSubmit={onSubmit}
      className={className}
    />
  )
}

function SlipForm({
  copy,
  state,
  onSubmit,
  className,
}: {
  copy: Copy
  state: WaitlistState
  onSubmit: (email: string, slip: string) => void
  className?: string
}) {
  const id = useId()
  // Until React takes over, a click would submit the form natively and
  // reload the page with the email in its URL.
  const hydrated = useHydrated()
  const view = Effect.runSync(viewOf(state, id, copy))
  const busy = state._tag === "Sending"
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const { email } = Effect.runSync(formFields(event.currentTarget, ["email"]))
    onSubmit(email, id)
  }
  return (
    <form
      noValidate
      onSubmit={submit}
      aria-busy={view.sending || undefined}
      className={cn("flex w-full max-w-[30rem] flex-col gap-3", className)}
    >
      <label
        htmlFor={`${id}-email`}
        className="text-ink-soft text-[12px] font-[750] tracking-[0.14em] uppercase [font-stretch:75%]"
      >
        {copy.emailLabel}
      </label>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          maxLength={254}
          placeholder={copy.emailPlaceholder}
          aria-invalid={view.invalid || undefined}
          aria-describedby={view.error ? `${id}-error` : `${id}-privacy`}
          disabled={busy}
          className={cn(
            "print border-ink text-ink caret-stamp placeholder:text-ink-soft min-h-12 min-w-0 flex-1 border-0 border-b-2 border-dashed bg-transparent px-1 text-[17px] outline-none",
            "focus-visible:border-stamp focus-visible:bg-paper/60 focus-visible:border-solid",
            "aria-invalid:border-down disabled:opacity-60"
          )}
        />
        <button
          type="submit"
          disabled={busy || !hydrated}
          className={cn(
            "bg-cloth text-foil min-h-12 shrink-0 rounded-[3px] px-5 text-[15px] font-[750] tracking-[0.02em] [font-stretch:92%] shadow-[0_2px_0_var(--cloth-deep),0_6px_14px_-6px_rgb(19_44_92/0.7)] transition-[transform,background-color,box-shadow] duration-150 ease-out",
            "hover:bg-[#21468c] active:translate-y-[2px] active:shadow-[0_0_0_var(--cloth-deep)]",
            "disabled:cursor-progress disabled:opacity-80"
          )}
        >
          {view.sending ? copy.joining : copy.join}
        </button>
      </div>
      <SlipNote id={id} copy={copy} error={view.error} />
    </form>
  )
}

function SlipNote({
  id,
  copy,
  error,
}: {
  id: string
  copy: Copy
  error: string | null
}) {
  return error ? (
    <p
      id={`${id}-error`}
      role="alert"
      className="text-down text-[14px] leading-[1.45]"
    >
      {error}
    </p>
  ) : (
    <p
      id={`${id}-privacy`}
      className="text-ink-soft text-[13px] leading-[1.45]"
    >
      {copy.privacy}
    </p>
  )
}
