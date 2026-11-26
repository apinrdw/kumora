import type { TablerIcon } from "@tabler/icons-react"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import type { ReactNode } from "react"

// Variant A of the sign-in prototype (branch prototype/sign-in-flow): a page
// with no shell, the brand panel beside the form, the form only on narrow
// screens.
export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <div className="bg-canvas grid min-h-svh lg:grid-cols-[1fr_480px]">
      <aside className="bg-surface relative hidden flex-col justify-between overflow-hidden border-r border-border p-10 lg:flex">
        <Wordmark />
        <div className="flex max-w-md flex-col gap-3">
          <p className="text-3xl font-bold tracking-tight">
            The IDX tape, live.
          </p>
          <p className="text-muted-foreground">
            Running trades, order books and candles from the whole market, kept
            for every trading day.
          </p>
        </div>
        <Tape />
      </aside>
      <main className="flex flex-col justify-center gap-6 px-6 py-12 sm:px-12">
        <div className="lg:hidden">
          <Wordmark />
        </div>
        <div className="flex flex-col gap-4">{children}</div>
      </main>
    </div>
  )
}

/** A screen with no form: an icon, a heading, text and its actions. */
export function Notice({
  icon: Icon,
  title,
  tone,
  children,
  actions,
}: {
  icon: TablerIcon
  title: string
  tone?: "down"
  children: ReactNode
  actions: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      <Icon
        aria-hidden
        className={cn("size-8", tone ? "text-down" : "text-primary")}
        stroke={1.5}
      />
      <h1 className="text-lg font-semibold">{title}</h1>
      <div className="flex flex-col gap-4 text-[13px] leading-5 text-muted-foreground">
        {children}
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
    </div>
  )
}

export const linkClass = "text-primary hover:underline"

/** The named fields of a submitted form, as text. */
export const formFields = <K extends string>(
  form: HTMLFormElement,
  names: ReadonlyArray<K>
): Effect.Effect<Record<K, string>> =>
  Effect.sync(() => {
    const data = new FormData(form)
    return Object.fromEntries(
      names.map((name) => {
        const value = data.get(name)
        return [name, typeof value === "string" ? value : ""]
      })
    ) as Record<K, string>
  })

/** An error from Better Auth, said in words a visitor can act on. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-down text-[13px]">
      {children}
    </p>
  )
}

function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <img src="/kumora-mark.png" alt="" className="size-8" />
      <b className="text-[15px] font-extrabold tracking-[-0.01em]">
        KUMORA<i className="text-primary not-italic">Terminal</i>
      </b>
    </span>
  )
}

// Decoration only: a few made-up rows in the shape of the tape.
const TAPE = [
  ["09:14:02", "BBCA", "9,875", "120", "up"],
  ["09:14:02", "TLKM", "3,210", "45", "down"],
  ["09:14:03", "BBRI", "4,560", "1,200", "up"],
  ["09:14:03", "GOTO", "68", "25,000", "down"],
  ["09:14:04", "ASII", "5,125", "300", "up"],
] as const

function Tape() {
  return (
    <div aria-hidden className="num flex flex-col gap-1 text-xs opacity-60">
      {TAPE.map(([time, code, price, lots, direction]) => (
        <div key={`${time}${code}`} className="grid grid-cols-4 gap-4">
          <span className="text-muted-foreground">{time}</span>
          <b>{code}</b>
          <span className={direction === "up" ? "text-up" : "text-down"}>
            {price}
          </span>
          <span>{lots}</span>
        </div>
      ))}
    </div>
  )
}
