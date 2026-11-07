import { useRouter } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"
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

/**
 * Runs a section's Better Auth call, then reloads the page's data so every
 * section (and the user menu) shows the result.
 */
export function useAccountAction() {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const run = async (action: () => Promise<Outcome>) => {
    setPending(true)
    setOutcome(null)
    const result = await action()
    if (result._tag === "Done") await router.invalidate()
    setOutcome(result)
    setPending(false)
  }
  return { pending, outcome, run }
}
