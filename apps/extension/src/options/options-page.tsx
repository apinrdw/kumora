import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Effect, Option, Schema } from "effect"
import { useEffect, useId, useState, type FormEvent } from "react"

import type { SignIn } from "../worker/ajaib-session.ts"
import type { RelayOutcome } from "../worker/code-list.ts"
import {
  AjaibPin,
  isCodeListRelayChange,
  isHeldCodeListChange,
  isSignInChange,
  isTargetStatesChange,
  loadCodeListRelay,
  loadHeldCodeList,
  loadSettings,
  loadSignIn,
  loadTargetStates,
  saveCodeListRelay,
  savePin,
  saveSettings,
  type TargetName,
  type TargetState,
  type TargetStates,
} from "../worker/settings.ts"
import { settingsFromForm } from "./form.ts"
import { optionsRuntime } from "./runtime.ts"

const stateLabels: Record<TargetState, string> = {
  off: "Off: no ingest token",
  connecting: "Connecting",
  connected: "Connected",
  retrying: "Unreachable, retrying",
  "rejected-token": "Ingest token rejected. Fix it and save.",
  "reload-extension":
    "The dashboard no longer accepts this extension. Rebuild and reload it.",
}

const signInLabels: Record<SignIn["state"], string> = {
  none: "No PIN entered: Ajaib's frames go without an account id until the tab shows one.",
  waiting: "PIN saved; it is tried once when an Ajaib tab is open.",
  "signing-in": "Signing in…",
  "signed-in": "Signed in.",
  "wrong-pin":
    "Ajaib refused the PIN. It is not tried again; enter it again to retry.",
  "needs-2fa":
    "Ajaib asks for a second factor. Sign in in the Ajaib tab instead.",
  failed:
    "The PIN check failed. It is not tried again; enter it again to retry.",
}

// Ajaib's PIN, kept in this browser session only (settings.ts) and tried
// once per entry from the Ajaib tab.
function AjaibSignIn() {
  const [pin, setPin] = useState("")
  const [signIn, setSignIn] = useState<SignIn>({ state: "none" })
  const [message, setMessage] = useState("")

  useEffect(() => {
    const refresh = () =>
      void optionsRuntime.runPromise(loadSignIn).then(setSignIn)
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (Effect.runSync(isSignInChange(changes, area))) refresh()
    }
    refresh()
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  const save = (event: FormEvent) => {
    event.preventDefault()
    const entered = Schema.decodeUnknownOption(AjaibPin)(pin.trim())
    if (Option.isNone(entered)) return setMessage("Enter the 6-digit PIN.")
    void optionsRuntime.runPromise(savePin(entered.value)).then(() => {
      setPin("")
      setMessage("")
    })
  }

  return (
    <form onSubmit={save}>
      <Card>
        <CardHeader>
          <CardTitle>Ajaib sign-in</CardTitle>
          <CardDescription>
            Optional. Kept only until Chrome closes, never sent to the
            dashboard. Enter it again after each Chrome start.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field
            label="Ajaib PIN"
            type="password"
            value={pin}
            onChange={setPin}
          />
          <div className="flex items-center gap-4">
            <Button type="submit">Sign in</Button>
            <p role="status" className="text-sm">
              {message}
            </p>
          </div>
          <p className="text-sm">
            State:{" "}
            <output aria-label="Ajaib sign-in state">
              {signInLabels[signIn.state]}
            </output>
          </p>
        </CardContent>
      </Card>
    </form>
  )
}

const relayLabels: Record<"asked" | RelayOutcome, string> = {
  asked: "Relaying…",
  fetched: "Fetched from Ajaib and sent to the connected targets.",
  resent:
    "Ajaib didn't answer, so today's held list was sent again to the connected targets.",
  missed:
    "Ajaib didn't answer and no list of today is held. Open the Ajaib tab, sign in, and try again; the service worker console says why.",
  busy: "A fetch is already under way. Try again in a moment.",
}

// The relay's held code list and a button that sends it up now: fetched
// fresh from the Ajaib tab, or today's held list again when Ajaib misses.
function CodeListRelayCard() {
  const [held, setHeld] = useState<{ date: string; count: number }>()
  const [relay, setRelay] = useState<"asked" | RelayOutcome>()

  useEffect(() => {
    const refreshHeld = () =>
      void optionsRuntime
        .runPromise(loadHeldCodeList)
        .then((loaded) => setHeld(Option.getOrUndefined(loaded)))
    const refreshRelay = () =>
      void optionsRuntime
        .runPromise(loadCodeListRelay)
        .then((loaded) => setRelay(Option.getOrUndefined(loaded)?.state))
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (Effect.runSync(isHeldCodeListChange(changes, area))) refreshHeld()
      if (Effect.runSync(isCodeListRelayChange(changes, area))) refreshRelay()
    }
    refreshHeld()
    refreshRelay()
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  const relayNow = () =>
    void optionsRuntime.runPromise(
      saveCodeListRelay({ state: "asked", at: Date.now() })
    )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Code list</CardTitle>
        <CardDescription>
          Fetched from the Ajaib tab once a day and sent to every target. Relay
          it by hand when Market Live's search has no codes.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm">
          Held:{" "}
          <output aria-label="Held code list">
            {held === undefined
              ? "None"
              : `${held.date}, ${held.count.toLocaleString("en")} codes`}
          </output>
        </p>
        <div className="flex items-center gap-4">
          <Button type="button" disabled={relay === "asked"} onClick={relayNow}>
            Relay the code list now
          </Button>
          <p role="status" className="text-sm">
            {relay === undefined ? "" : relayLabels[relay]}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}

const targetLabels: Record<TargetName, string> = {
  production: "Production",
  extra: "Extra target",
}

function TargetStateLine({
  name,
  states,
}: {
  name: TargetName
  states: TargetStates | undefined
}) {
  return (
    <p className="text-sm">
      State:{" "}
      <output aria-label={`${targetLabels[name]} state`}>
        {states === undefined ? "Unknown" : stateLabels[states[name]]}
      </output>
    </p>
  )
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: "text" | "password" | "url"
  placeholder?: string
}) {
  const id = useId()
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

export function OptionsPage() {
  const [productionToken, setProductionToken] = useState("")
  const [extraUrl, setExtraUrl] = useState("")
  const [extraToken, setExtraToken] = useState("")
  const [states, setStates] = useState<TargetStates>()
  const [message, setMessage] = useState("")

  useEffect(() => {
    void optionsRuntime.runPromise(loadSettings).then((settings) => {
      setProductionToken(settings.productionToken)
      setExtraUrl(settings.extra?.origin ?? "")
      setExtraToken(settings.extra?.token ?? "")
    })
    const refresh = () =>
      void optionsRuntime
        .runPromise(loadTargetStates)
        .then((loaded) => setStates(Option.getOrUndefined(loaded)))
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (Effect.runSync(isTargetStatesChange(changes, area))) refresh()
    }
    refresh()
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  const save = (event: FormEvent) => {
    event.preventDefault()
    void optionsRuntime
      .runPromise(
        settingsFromForm({ productionToken, extraUrl, extraToken }).pipe(
          Effect.flatMap(saveSettings),
          Effect.as("Saved."),
          Effect.catchTag("InvalidDashboardUrl", () =>
            Effect.succeed(
              "Enter the extra target's dashboard URL, such as https://kumora-dashboard-staging.kumora.workers.dev."
            )
          )
        )
      )
      .then(setMessage)
  }

  return (
    <main className="mx-auto grid max-w-xl gap-6 p-6">
      <h1 className="text-xl font-semibold">Kumora relay</h1>
      <form className="grid gap-6" onSubmit={save}>
        <Card>
          <CardHeader>
            <CardTitle>Production</CardTitle>
            <CardDescription>
              Always relayed, to {__PRODUCTION_DASHBOARD__}.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field
              label="Production ingest token"
              type="password"
              value={productionToken}
              onChange={setProductionToken}
            />
            <TargetStateLine name="production" states={states} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Extra target</CardTitle>
            <CardDescription>
              Optional: Staging, a Preview or a Dev stage. Leave the URL empty
              for none. A failing extra target never affects Production.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <Field
              label="Extra target URL"
              type="url"
              placeholder="https://kumora-dashboard-staging.kumora.workers.dev"
              value={extraUrl}
              onChange={setExtraUrl}
            />
            <Field
              label="Extra target ingest token"
              type="password"
              value={extraToken}
              onChange={setExtraToken}
            />
            <TargetStateLine name="extra" states={states} />
          </CardContent>
        </Card>
        <div className="flex items-center gap-4">
          <Button type="submit">Save</Button>
          <p role="status" className="text-sm">
            {message}
          </p>
        </div>
      </form>
      <CodeListRelayCard />
      <AjaibSignIn />
    </main>
  )
}
