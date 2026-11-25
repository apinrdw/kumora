import { Link } from "@tanstack/react-router"
import { cn } from "@workspace/ui/lib/utils"

import { COPY, type Lang } from "@/lib/copy"

import { Ledger } from "./ledger"
import { Saldo } from "./saldo"
import { useWaitlist } from "./use-waitlist"
import { WaitlistSlip } from "./waitlist-slip"

// Production's dashboard: the sign-in for people already let in.
const SIGN_IN_URL = "https://kumora-dashboard.kumora.workers.dev/sign-in"

const gutter = "px-[max(16px,env(safe-area-inset-left))] sm:px-6 lg:px-10"
const frame = "mx-auto w-full max-w-[1240px]"
// A sheet of passbook paper lying on the cloth.
const sheet =
  "paper relative rounded-[3px] shadow-[0_1px_0_var(--paper-edge),0_18px_40px_-18px_rgb(8_20_48/0.75)]"

/** The landing page: an open KUMORA passbook. */
export function Landing({ lang }: { lang: Lang }) {
  const copy = COPY[lang]
  const { state, submit } = useWaitlist(lang)
  const other: Lang = lang === "en" ? "id" : "en"

  return (
    <div className="text-ink min-h-svh">
      <svg aria-hidden className="absolute size-0">
        <filter id="stamp-ink">
          {/* Fine specks where the rubber missed, a wobble on every edge,
              and broad blotches where the ink ran thin or pooled. */}
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="2"
            seed="7"
            result="speck"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="speck"
            scale="2.4"
            result="rough"
          />
          <feComponentTransfer in="speck" result="speckMask">
            <feFuncA type="discrete" tableValues="0 0 1 1 1 1 1 0.6 1" />
          </feComponentTransfer>
          <feComposite
            in="rough"
            in2="speckMask"
            operator="in"
            result="specked"
          />
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.07"
            numOctaves="1"
            seed="3"
            result="blot"
          />
          <feComponentTransfer in="blot" result="blotMask">
            <feFuncA type="table" tableValues="0.3 0.7 1 1" />
          </feComponentTransfer>
          <feComposite in="specked" in2="blotMask" operator="in" />
        </filter>
      </svg>
      <header className={cn(gutter, "pt-[max(14px,env(safe-area-inset-top))]")}>
        <div
          className={cn(frame, "flex items-center justify-between gap-4 py-3")}
        >
          <div className="flex items-center gap-4">
            <img
              src="/kumora-wordmark.png"
              alt="KUMORA AI"
              width={640}
              height={204}
              className="h-11 w-auto sm:h-14"
            />
            <span className="text-foil-dim border-foil-dim/30 border-l pl-4 text-[12px] leading-[1.3] font-[650] tracking-[0.14em] uppercase [font-stretch:80%] max-md:hidden">
              Follow the
              <br />
              smart money
            </span>
          </div>
          <nav className="text-foil flex items-center gap-x-5 gap-y-1 text-[14px] max-sm:flex-col max-sm:items-end">
            <Link
              to={other === "id" ? "/id" : "/"}
              hrefLang={other}
              lang={other}
              aria-label={copy.switchLabel}
              className="decoration-foil-dim/70 hover:decoration-foil font-[650] underline"
            >
              {copy.switchTo}
            </Link>
            <span className="text-foil-dim max-sm:hidden">
              {copy.hasAccess}{" "}
              <a
                href={SIGN_IN_URL}
                className="text-foil decoration-foil-dim/70 hover:decoration-foil font-[650] underline"
              >
                {copy.signIn}
              </a>
            </span>
          </nav>
        </div>
      </header>

      <main className="flex flex-col gap-14 pb-16 sm:gap-20">
        <section className={cn(gutter, "pt-2 sm:pt-4")}>
          <div
            className={cn(
              frame,
              "grid overflow-hidden rounded-[4px] shadow-[0_2px_0_var(--paper-edge),0_30px_60px_-24px_rgb(6_16_40/0.85)] lg:grid-cols-2"
            )}
          >
            <div className="paper relative flex flex-col gap-6 px-5 pt-8 pb-6 sm:px-10 sm:pt-12 lg:pr-14">
              <h1 className="text-ink max-w-[16ch] text-[clamp(2.4rem,5.4vw,4.4rem)] leading-[0.98] font-[850] tracking-[-0.025em] text-balance [font-stretch:112%]">
                {copy.hook}
              </h1>
              <p className="text-ink-soft max-w-[46ch] text-[17px] leading-[1.6]">
                {copy.lede}
              </p>
              <WaitlistSlip copy={copy} state={state} onSubmit={submit} />
              <p className="text-ink-soft text-[14px] sm:hidden">
                {copy.hasAccess}{" "}
                <a
                  href={SIGN_IN_URL}
                  className="text-cloth font-[650] underline"
                >
                  {copy.signIn}
                </a>
              </p>
              <p className="text-ink-faint mt-auto pt-4 text-[11px] tracking-[0.14em] uppercase [font-stretch:75%]">
                {copy.formCode}
              </p>
            </div>
            {/* The spine: the two pages meet in a shaded fold. */}
            <div className="paper max-lg:border-rule relative px-5 pt-6 pb-6 max-lg:border-t-2 max-lg:border-dashed sm:px-10 sm:pt-10 lg:pl-14 lg:before:absolute lg:before:inset-y-0 lg:before:left-0 lg:before:w-10 lg:before:bg-[linear-gradient(90deg,rgb(20_40_30/0.18),transparent)]">
              <Ledger copy={copy} lang={lang} />
            </div>
          </div>
        </section>

        <section className={gutter}>
          <div className={cn(frame, sheet, "px-5 py-10 sm:px-10 sm:py-14")}>
            <Saldo copy={copy} lang={lang} />
          </div>
        </section>

        <section className={gutter}>
          <div
            className={cn(
              frame,
              sheet,
              "flex flex-col gap-8 px-5 py-10 sm:px-10 sm:py-14"
            )}
          >
            <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-end lg:gap-14">
              <h2 className="text-[clamp(1.75rem,3.2vw,2.6rem)] leading-[1.06] font-[800] tracking-[-0.015em] text-balance [font-stretch:108%]">
                {copy.indexHeading}
              </h2>
              <p className="text-ink-soft max-w-[46ch] text-[17px] leading-[1.6]">
                {copy.indexBody}
              </p>
            </div>
            <dl className="border-cloth/60 grid border-t-2 lg:grid-cols-2 lg:gap-x-14">
              {copy.index.map((entry) => (
                <div
                  key={entry.name}
                  className="border-rule grid gap-1 border-b border-dashed py-4 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-6"
                >
                  <dt className="text-ink text-[16px] leading-[1.4] font-[750] [font-stretch:90%]">
                    {entry.name}
                  </dt>
                  <dd className="text-ink-soft max-w-[52ch] text-[16px] leading-[1.55]">
                    {entry.body}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className={gutter} aria-labelledby="close-heading">
          <div
            className={cn(
              frame,
              "grid gap-8 py-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:items-center lg:gap-14"
            )}
          >
            <div className="text-foil flex flex-col gap-4">
              <h2
                id="close-heading"
                className="text-[clamp(2rem,4vw,3.2rem)] leading-[1.02] font-[850] tracking-[-0.02em] text-balance [font-stretch:112%]"
              >
                {copy.closeHeading}
              </h2>
              <p className="text-foil-dim max-w-[40ch] text-[17px] leading-[1.6]">
                {copy.closeBody}
              </p>
            </div>
            <div className={cn(sheet, "px-5 py-8 sm:px-10")}>
              <WaitlistSlip copy={copy} state={state} onSubmit={submit} />
            </div>
          </div>
        </section>
      </main>

      <footer
        className={cn(
          gutter,
          "border-foil-dim/25 border-t pt-8 pb-[max(32px,env(safe-area-inset-bottom))]"
        )}
      >
        <div
          className={cn(
            frame,
            "text-foil-dim flex flex-col gap-2 text-[13px] leading-[1.55]"
          )}
        >
          <p className="max-w-[72ch]">{copy.disclaimer}</p>
          <p className="max-w-[72ch]">{copy.dataNote}</p>
          <p>© 2026 KUMORA</p>
        </div>
      </footer>
    </div>
  )
}
