import { useRouter } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useId, useState, type ReactNode } from "react"

import { kCard } from "@/components/k"

/**
 * One section of `/account`: a titled card. Each section is its own component
 * that takes only what it shows and whether the access policy allows its
 * action, so a new section is one more child of the page.
 */
export function AccountSection({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={cn(kCard, "flex flex-col gap-4")}>
      <header className="flex flex-col gap-1">
        <h2 id={id} className="text-[15px] font-semibold">
          {title}
        </h2>
        {description && (
          <p className="text-[13px] text-muted-foreground">{description}</p>
        )}
      </header>
      {children}
    </section>
  )
}

/** What a section's action said last: a confirmation or an error. */
export type Outcome =
  | { readonly _tag: "Done"; readonly message: string }
  | { readonly _tag: "Failed"; readonly message: string }

export function OutcomeLine({ outcome }: { outcome: Outcome | null }) {
  if (outcome === null) return null
  return outcome._tag === "Done" ? (
    <p role="status" className="text-up text-[13px]">
      {outcome.message}
    </p>
  ) : (
    <p role="alert" className="text-down text-[13px]">
      {outcome.message}
    </p>
  )
}

const runAction = Effect.fnUntraced(function* (
  action: Effect.Effect<Outcome>,
  reload: Effect.Effect<void>,
  show: {
    pending: (pending: boolean) => void
    outcome: (o: Outcome | null) => void
  }
) {
  yield* Effect.sync(() => {
    show.pending(true)
    show.outcome(null)
  })
  const result = yield* action
  if (result._tag === "Done") yield* reload
  yield* Effect.sync(() => {
    show.outcome(result)
    show.pending(false)
  })
})

/**
 * Runs a section's Better Auth call, then reloads the page's data so every
 * section (and the user menu) shows the result. `run` returns the Effect;
 * the section's event handler forks it.
 */
export function useAccountAction() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const run = (action: Effect.Effect<Outcome>) =>
    runAction(
      action,
      Effect.promise(() => router.invalidate()),
      { pending: setPending, outcome: setOutcome }
    )
  return { pending, outcome, run }
}
