// PROTOTYPE, throwaway: three layouts for the auth screens. No auth runs; buttons only move between screens.
import {
  IconArrowLeft,
  IconBan,
  IconBrandGoogleFilled,
  IconLock,
  IconMailCheck,
} from "@tabler/icons-react"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

import { KButton, KInput, KSkeleton, kCard } from "@/components/k"

export type Screen =
  | "signin"
  | "signup"
  | "verify"
  | "unverified"
  | "forgot"
  | "reset-sent"
  | "reset"
  | "banned"
export type Stage = "production" | "preview"

export const SCREENS: ReadonlyArray<{ key: Screen; name: string }> = [
  { key: "signin", name: "Sign in" },
  { key: "signup", name: "Sign up" },
  { key: "verify", name: "Check inbox (just signed up)" },
  { key: "unverified", name: "Signed in, unverified" },
  { key: "forgot", name: "Forgot password" },
  { key: "reset-sent", name: "Reset link sent" },
  { key: "reset", name: "New password (from link)" },
  { key: "banned", name: "Banned" },
]
export const STAGES: ReadonlyArray<{ key: Stage; name: string }> = [
  { key: "production", name: "Production / staging (Google)" },
  { key: "preview", name: "Preview (no Google)" },
]

type Props = { screen: Screen; google: boolean; go: (s: Screen) => void }

const EMAIL = "rina@example.com"

/* ── shared bits (fields only; each variant owns its layout) ─────────── */

function GoogleButton({ label }: { label: string }) {
  return (
    <KButton variant="secondary" size="lg" icon={IconBrandGoogleFilled}>
      {label}
    </KButton>
  )
}

function Or() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

function TextLink({
  onClick,
  children,
}: {
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-primary hover:underline"
    >
      {children}
    </button>
  )
}

/** Screen bodies used by A and B. C has its own identifier-first flow. */
function Body({ screen, google, go }: Props) {
  switch (screen) {
    case "signin":
      return (
        <>
          {google && (
            <>
              <GoogleButton label="Continue with Google" />
              <Or />
            </>
          )}
          <KInput label="Email" type="email" size="md" defaultValue={EMAIL} />
          <KInput label="Password" type="password" size="md" />
          <div className="flex justify-end text-xs">
            <TextLink onClick={() => go("forgot")}>Forgot password?</TextLink>
          </div>
          <KButton size="lg" onClick={() => go("unverified")}>
            Sign in
          </KButton>
          <p className="text-center text-xs text-muted-foreground">
            New here?{" "}
            <TextLink onClick={() => go("signup")}>Create an account</TextLink>
          </p>
        </>
      )
    case "signup":
      return (
        <>
          {google && (
            <>
              <GoogleButton label="Sign up with Google" />
              <Or />
            </>
          )}
          <KInput label="Name" size="md" defaultValue="Rina" />
          <KInput label="Email" type="email" size="md" defaultValue={EMAIL} />
          <KInput
            label="Password"
            type="password"
            size="md"
            hint="At least 12 characters."
          />
          <KButton size="lg" onClick={() => go("verify")}>
            Create account
          </KButton>
          <p className="text-center text-xs text-muted-foreground">
            Have an account?{" "}
            <TextLink onClick={() => go("signin")}>Sign in</TextLink>
          </p>
        </>
      )
    case "verify":
      return (
        <Notice icon={IconMailCheck} title="Check your inbox">
          We sent a link to <b className="text-foreground">{EMAIL}</b>. Open it
          to finish creating your account; it brings you back to Market Live.
          <Actions>
            <KButton variant="secondary">Resend link</KButton>
            <KButton variant="ghost" onClick={() => go("signup")}>
              Use another email
            </KButton>
          </Actions>
        </Notice>
      )
    case "unverified":
      return (
        <Notice icon={IconMailCheck} title="Verify your email to continue">
          You're signed in as <b className="text-foreground">{EMAIL}</b>, but
          the dashboard shows data only to verified accounts. The link we sent
          expires in 24 hours.
          <Actions>
            <KButton>Resend link</KButton>
            <KButton variant="ghost" onClick={() => go("signin")}>
              Sign out
            </KButton>
          </Actions>
        </Notice>
      )
    case "forgot":
      return (
        <>
          <p className="text-[13px] text-muted-foreground">
            Enter your account's email and we'll send a reset link.
          </p>
          <KInput label="Email" type="email" size="md" defaultValue={EMAIL} />
          <KButton size="lg" onClick={() => go("reset-sent")}>
            Send reset link
          </KButton>
          <TextLink onClick={() => go("signin")}>Back to sign in</TextLink>
        </>
      )
    case "reset-sent":
      return (
        <Notice icon={IconMailCheck} title="Reset link sent">
          If <b className="text-foreground">{EMAIL}</b> has an account, a reset
          link is on its way. It expires in 1 hour.
          <Actions>
            <KButton variant="ghost" onClick={() => go("signin")}>
              Back to sign in
            </KButton>
          </Actions>
        </Notice>
      )
    case "reset":
      return (
        <>
          <KInput
            label="New password"
            type="password"
            size="md"
            hint="At least 12 characters. Signs you out on other devices."
          />
          <KButton size="lg" onClick={() => go("signin")}>
            Set password and sign in
          </KButton>
        </>
      )
    case "banned":
      return (
        <Notice icon={IconBan} title="This account is suspended" tone="down">
          An admin suspended <b className="text-foreground">{EMAIL}</b>. You
          can't sign in with it. Reply to any email from KUMORA to ask why.
          <Actions>
            <KButton variant="ghost" onClick={() => go("signin")}>
              Back to sign in
            </KButton>
          </Actions>
        </Notice>
      )
  }
}

const TITLE: Record<Screen, string> = {
  signin: "Sign in to KUMORA",
  signup: "Create your account",
  verify: "",
  unverified: "",
  forgot: "Reset your password",
  "reset-sent": "",
  reset: "Choose a new password",
  banned: "",
}

function Notice({
  icon: Icon,
  title,
  tone,
  children,
}: {
  icon: typeof IconLock
  title: string
  tone?: "down"
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      <Icon
        className={cn("size-8", tone ? "text-down" : "text-primary")}
        stroke={1.5}
      />
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="flex flex-col gap-4 text-[13px] leading-5 text-muted-foreground">
        {children}
      </div>
    </div>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>
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

/* ── A: standalone page, no shell. /sign-in?redirect=/market-live ──── */

function VariantA(p: Props) {
  return (
    <div className="bg-canvas fixed inset-0 z-40 grid overflow-y-auto lg:grid-cols-[1fr_480px]">
      <aside className="bg-surface relative hidden flex-col justify-between overflow-hidden border-r border-border p-10 lg:flex">
        <Wordmark />
        <div className="flex max-w-md flex-col gap-3">
          <h1 className="text-3xl font-bold tracking-tight">
            The IDX tape, live.
          </h1>
          <p className="text-muted-foreground">
            Running trades, order books and candles from the whole market, kept
            for every trading day.
          </p>
        </div>
        <FakeTape />
      </aside>
      <main className="flex flex-col justify-center gap-6 px-6 py-12 sm:px-12">
        <div className="lg:hidden">
          <Wordmark />
        </div>
        <span className="num text-[11px] text-muted-foreground">
          /sign-in?redirect=/market-live
        </span>
        {TITLE[p.screen] && (
          <h2 className="text-xl font-semibold">{TITLE[p.screen]}</h2>
        )}
        <div className="flex flex-col gap-4">
          <Body {...p} />
        </div>
      </main>
    </div>
  )
}

function FakeTape() {
  const rows = [
    ["09:14:02", "BBCA", "9,875", "120", "up"],
    ["09:14:02", "TLKM", "3,210", "45", "down"],
    ["09:14:03", "BBRI", "4,560", "1,200", "up"],
    ["09:14:03", "GOTO", "68", "25,000", "down"],
    ["09:14:04", "ASII", "5,125", "300", "up"],
  ]
  return (
    <div className="num flex flex-col gap-1 text-xs opacity-60">
      {rows.map((r) => (
        <div key={r.join()} className="grid grid-cols-4 gap-4">
          <span className="text-muted-foreground">{r[0]}</span>
          <b>{r[1]}</b>
          <span className={r[4] === "up" ? "text-up" : "text-down"}>
            {r[2]}
          </span>
          <span>{r[3]}</span>
        </div>
      ))}
    </div>
  )
}

/* ── B: inside the shell. The URL stays /market-live; main shows the form. ── */

function VariantB(p: Props) {
  const lockedState =
    p.screen === "unverified" || p.screen === "banned" || p.screen === "verify"
  return (
    <div className="flex flex-col gap-6">
      <div className="bg-surface flex items-center justify-between rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="num">/market-live (URL unchanged)</span>
        <span className="flex items-center gap-2">
          {p.screen === "unverified" ? (
            <span className="text-foreground">{EMAIL} · unverified</span>
          ) : (
            <KButton
              size="sm"
              variant="secondary"
              onClick={() => p.go("signin")}
            >
              Sign in
            </KButton>
          )}
        </span>
      </div>
      {p.screen === "unverified" && (
        <div className="border-warning/40 bg-warning/10 rounded-md border px-3 py-2 text-[13px]">
          Verify <b>{EMAIL}</b> to see Market Live.{" "}
          <button type="button" className="text-primary hover:underline">
            Resend link
          </button>
        </div>
      )}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Market Live</h1>
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <IconLock className="size-4" /> Sign in to see this page.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[400px_1fr]">
        <section className={cn(kCard, "flex flex-col gap-4 p-6")}>
          {TITLE[p.screen] && (
            <h2 className="text-lg font-semibold">{TITLE[p.screen]}</h2>
          )}
          <Body {...p} />
        </section>
        <div
          aria-hidden
          className={cn(
            "hidden flex-col gap-3 lg:flex",
            lockedState ? "opacity-20" : "opacity-40"
          )}
        >
          <KSkeleton kind="chart" height={256} />
          <div className="grid grid-cols-2 gap-3">
            <KSkeleton kind="chart" height={160} />
            <KSkeleton kind="chart" height={160} />
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── C: dialog over a blurred page. One identifier-first flow:
       email → (known: password) | (new: name + password) ─────────────── */

function VariantC(p: Props) {
  return (
    <div className="relative">
      <div aria-hidden className="flex flex-col gap-3 blur-sm">
        <h1 className="text-2xl font-bold">Market Live</h1>
        <div className="grid gap-3 lg:grid-cols-[1fr_360px]">
          <KSkeleton kind="chart" height={420} />
          <div className="flex flex-col gap-3">
            <KSkeleton kind="chart" height={192} />
            <KSkeleton kind="chart" height={224} />
          </div>
        </div>
      </div>
      <div className="bg-canvas/60 fixed inset-0 z-30 flex items-center justify-center p-4 backdrop-blur-[2px]">
        <div
          role="dialog"
          aria-modal
          className={cn(
            kCard,
            "flex w-full max-w-sm flex-col gap-4 p-6 shadow-2xl"
          )}
        >
          <Wordmark />
          <CFlow {...p} />
        </div>
      </div>
    </div>
  )
}

function CFlow({ screen, google, go }: Props) {
  const back = (to: Screen) => (
    <button
      type="button"
      onClick={() => go(to)}
      className="flex w-fit items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <IconArrowLeft className="size-3.5" /> {EMAIL}
    </button>
  )
  switch (screen) {
    case "signin":
      return (
        <>
          <p className="text-[13px] text-muted-foreground">
            Sign in or create an account to see Market Live.
          </p>
          {google && (
            <>
              <GoogleButton label="Continue with Google" />
              <Or />
            </>
          )}
          <KInput label="Email" type="email" size="md" defaultValue={EMAIL} />
          <KButton size="lg" onClick={() => go("signup")}>
            Continue
          </KButton>
          <p className="text-[11px] text-muted-foreground">
            Continue checks the email: a known one asks for its password, a new
            one creates an account. (Try screen "Sign up" for a new email.)
          </p>
        </>
      )
    case "signup":
      return (
        <>
          {back("signin")}
          <h2 className="text-base font-semibold">
            New here: create a password
          </h2>
          <KInput label="Name" size="md" defaultValue="Rina" />
          <KInput
            label="Password"
            type="password"
            size="md"
            hint="At least 12 characters."
          />
          <KButton size="lg" onClick={() => go("verify")}>
            Create account
          </KButton>
          <h2 className="mt-2 border-t border-border pt-4 text-base font-semibold">
            …or, for a known email
          </h2>
          <KInput label="Password" type="password" size="md" />
          <div className="flex items-center justify-between text-xs">
            <TextLink onClick={() => go("forgot")}>Forgot password?</TextLink>
            <KButton onClick={() => go("unverified")}>Sign in</KButton>
          </div>
        </>
      )
    case "forgot":
      return (
        <>
          {back("signin")}
          <p className="text-[13px] text-muted-foreground">
            We'll email a reset link to this address.
          </p>
          <KButton size="lg" onClick={() => go("reset-sent")}>
            Send reset link
          </KButton>
        </>
      )
    default:
      return <Body screen={screen} google={google} go={go} />
  }
}

export const VARIANTS = [
  { key: "A", name: "Standalone page, redirect", View: VariantA },
  { key: "B", name: "In the shell, URL kept", View: VariantB },
  { key: "C", name: "Dialog over page, email first", View: VariantC },
] as const
