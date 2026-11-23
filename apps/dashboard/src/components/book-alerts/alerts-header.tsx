// The radar header's Alert rules and Alerts bell (spec apinrdw/kumora#517,
// "Alerts"): this browser's rules, its chime, and today's alerts.
import { IconBell, IconTrash } from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { clientRuntime } from "@workspace/client"
import type { StockCode } from "@workspace/relay"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useState } from "react"

import { KButton, KIconButton } from "@/components/k/button"
import { KInput } from "@/components/k/input"
import { Pressed } from "@/components/market-bubbles/pressed"
import {
  ALERT_KIND_NAMES,
  alertLink,
  alertRises,
  isBookEventKind,
  MIN_VALUES,
  type AlertKind,
  type AlertRule,
  type AlertScope,
  type MinValue,
} from "@/lib/book-alerts"
import { compact, tapeTime } from "@/lib/format"
import { parseMarketLiveSearch } from "@/lib/market-live-search"

import {
  alertBell,
  alertChime,
  alertDay,
  alertHistory,
  alertRules,
  useStored,
} from "./alert-store"

const KINDS = Object.keys(ALERT_KIND_NAMES) as ReadonlyArray<AlertKind>

const SCOPES: ReadonlyArray<{ value: AlertScope["_tag"]; label: string }> = [
  { value: "watchlist", label: "Watchlist" },
  { value: "codes", label: "Named codes" },
  { value: "scanner", label: "Every scanner code" },
]

const minValueLabel = (value: MinValue) =>
  value === 0
    ? Effect.succeed("Any value")
    : Effect.map(compact(value), (n) => `Rp${n}`)

const MIN_VALUE_OPTIONS = MIN_VALUES.map((value) => ({
  value,
  label: Effect.runSync(minValueLabel(value)),
}))

// The codes typed in, parsed as the URL's are: the rest dropped.
const codesOf = Effect.fnUntraced(function* (text: string) {
  const codes = yield* Effect.forEach(
    text.toUpperCase().split(/[\s,]+/),
    (word) =>
      Effect.map(parseMarketLiveSearch({ code: word }), ({ code }) => code)
  )
  return [...new Set(codes.filter((code) => code !== undefined))]
})

const scopeText = (scope: AlertScope) =>
  Effect.succeed(
    scope._tag === "codes"
      ? scope.codes.join(", ")
      : SCOPES.find((each) => each.value === scope._tag)!.label
  )

// "Wall pulled, Eaten · Watchlist · Rp5 B and up".
const ruleText = Effect.fnUntraced(function* (rule: AlertRule) {
  return [
    rule.kinds.map((kind) => ALERT_KIND_NAMES[kind]).join(", "),
    yield* scopeText(rule.scope),
    rule.minValue === 0
      ? "any value"
      : `${yield* minValueLabel(rule.minValue)} and up`,
  ].join(" · ")
})

// Permission for background notifications is asked when the first
// rule is saved, the moment the user shows they want alerts. See spec
// apinrdw/kumora#517, "Alerts".
const askToNotify = Effect.sync(() => {
  if (typeof Notification === "undefined") return
  if (Notification.permission === "default")
    void Notification.requestPermission()
})

function NewRule() {
  const [kinds, setKinds] = useState<ReadonlyArray<AlertKind>>([])
  const [scope, setScope] = useState<AlertScope["_tag"]>("watchlist")
  const [codesText, setCodesText] = useState("")
  const [minValue, setMinValue] = useState<MinValue>(0)
  const codes: ReadonlyArray<StockCode> = Effect.runSync(codesOf(codesText))
  const ready = kinds.length > 0 && (scope !== "codes" || codes.length > 0)
  const save = () => {
    const rules = alertRules.get()
    if (rules.length === 0) clientRuntime.runSync(askToNotify)
    alertRules.set([
      ...rules,
      {
        id: crypto.randomUUID(),
        kinds,
        scope: scope === "codes" ? { _tag: "codes", codes } : { _tag: scope },
        minValue,
      },
    ])
    setKinds([])
    setCodesText("")
  }
  return (
    <section
      aria-label="New rule"
      className="flex flex-col gap-2.5 border-t border-border pt-3 text-[12px]"
    >
      <h3 className="font-semibold">New rule</h3>
      <div
        role="group"
        aria-label="Event kinds"
        className="flex flex-wrap gap-1.5"
      >
        {KINDS.map((kind) => {
          const on = kinds.includes(kind)
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setKinds(
                  on ? kinds.filter((k) => k !== kind) : [...kinds, kind]
                )
              }
              className={cn(
                "rounded-md border border-border px-2 py-1 font-semibold",
                on
                  ? "bg-primary text-primary-foreground"
                  : "bg-surface text-secondary-text hover:bg-elevated"
              )}
            >
              {ALERT_KIND_NAMES[kind]}
            </button>
          )
        })}
      </div>
      <Pressed label="Scope" options={SCOPES} value={scope} onPick={setScope} />
      {scope === "codes" && (
        <KInput
          label="Codes"
          placeholder="BBCA, TLKM"
          value={codesText}
          onChange={(event) => setCodesText(event.target.value)}
        />
      )}
      <Pressed
        label="Minimum value"
        options={MIN_VALUE_OPTIONS}
        value={minValue}
        onPick={setMinValue}
      />
      {!kinds.every((kind) => Effect.runSync(isBookEventKind(kind))) && (
        <p className="text-muted-foreground">
          Minimum value applies only to book event kinds.
        </p>
      )}
      <KButton
        size="sm"
        disabled={!ready}
        onClick={save}
        className="self-start"
      >
        Save rule
      </KButton>
    </section>
  )
}

/** The header's Alert rules button and its sheet. */
export function AlertRules() {
  const [open, setOpen] = useState(false)
  const rules = useStored(alertRules)
  const chime = useStored(alertChime)
  return (
    <>
      <KButton variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Alert rules{rules.length > 0 ? ` (${rules.length})` : ""}
      </KButton>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="overflow-y-auto">
          <SheetHeader className="pb-0">
            <SheetTitle>Alert rules</SheetTitle>
            <SheetDescription>
              Alerts fire while the order book radar or Market Live is open,
              live only. The same code and kind alert at most once in 2 minutes,
              and at most 6 a minute.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-4 pb-4">
            {rules.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">No rules yet.</p>
            ) : (
              <ul aria-label="Rules" className="flex flex-col gap-1">
                {rules.map((rule) => (
                  <li
                    key={rule.id}
                    className="flex items-center justify-between gap-2 text-[12px]"
                  >
                    <span>{Effect.runSync(ruleText(rule))}</span>
                    <KIconButton
                      icon={IconTrash}
                      label="Remove rule"
                      size="sm"
                      tooltip={false}
                      onClick={() =>
                        alertRules.set(
                          alertRules.get().filter((each) => each.id !== rule.id)
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
            <NewRule />
            <label className="flex items-center gap-2 border-t border-border pt-3 text-[12px]">
              <input
                type="checkbox"
                checked={chime}
                onChange={(event) => alertChime.set(event.target.checked)}
              />
              Chime on each alert
            </label>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

/** The header's Alerts bell: today's alerts, newest first. */
export function AlertsBell() {
  const open = useStored(alertBell)
  const history = useStored(alertHistory)
  const today = useStored(alertDay)
  const alerts =
    today === undefined || history.day === today ? history.alerts : []
  const navigate = useNavigate()
  return (
    <>
      <KButton
        variant="secondary"
        size="sm"
        icon={IconBell}
        onClick={() => alertBell.set(true)}
      >
        Alerts{alerts.length > 0 ? ` (${alerts.length})` : ""}
      </KButton>
      <Sheet open={open} onOpenChange={alertBell.set}>
        <SheetContent side="right" className="overflow-y-auto">
          <SheetHeader className="pb-0">
            <SheetTitle>Alerts</SheetTitle>
            <SheetDescription>
              Today's alerts in this browser, newest first.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            {alerts.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                No alerts yet today.
              </p>
            ) : (
              <ol aria-label="Today's alerts" className="flex flex-col">
                {alerts.map((alert) => (
                  <li
                    key={alert.key}
                    className="flex items-start gap-2 border-t border-border py-1.5 text-[12px]"
                  >
                    <span className="text-muted-foreground tabular-nums">
                      {Effect.runSync(tapeTime(alert.at))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block font-medium",
                          Effect.runSync(alertRises(alert))
                            ? "text-up"
                            : "text-down"
                        )}
                      >
                        {alert.title}
                      </span>
                      <span className="text-muted-foreground">
                        {alert.detail}
                      </span>
                    </span>
                    <KButton
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        alertBell.set(false)
                        void navigate({
                          to: "/market-live",
                          search: Effect.runSync(alertLink(alert)),
                        })
                      }}
                    >
                      Open
                    </KButton>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
