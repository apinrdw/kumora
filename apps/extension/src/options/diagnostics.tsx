import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Effect, Option } from "effect"
import { useState } from "react"

import {
  errorLogStore,
  isErrorLogChange,
  isRelayStoppedChange,
  loadDiagnosticKeys,
  loadRelayStopped,
  stallRecordStore,
} from "../worker/settings.ts"
import { diagnosticsText } from "./diagnostics-text.ts"
import { optionsRuntime } from "./runtime.ts"
import { useStored } from "./use-stored.ts"

const copyDiagnostics = Effect.gen(function* () {
  const text = yield* diagnosticsText({
    version: chrome.runtime.getManifest().version,
    stopped: yield* loadRelayStopped,
    errors: yield* errorLogStore.load,
    keys: yield* loadDiagnosticKeys,
    stalls: yield* stallRecordStore.load,
  })
  yield* Effect.tryPromise(() => navigator.clipboard.writeText(text))
})

// Shown once the worker's main loop ended: nothing relays or walks until
// the extension is reloaded.
export function RelayStoppedAlert() {
  const stopped = useStored(
    loadRelayStopped,
    isRelayStoppedChange,
    Option.none()
  )
  if (Option.isNone(stopped)) return null
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive p-4 text-sm"
    >
      <p className="font-semibold">Relay stopped</p>
      <p>
        The relay stopped at {new Date(stopped.value.at).toLocaleString()}.
        Nothing relays or walks until you reload the extension on
        chrome://extensions. Copy diagnostics first to keep its cause.
      </p>
    </div>
  )
}

export function DiagnosticsCard() {
  const errors = useStored(errorLogStore.load, isErrorLogChange, [])
  const [message, setMessage] = useState("")
  const copy = () =>
    void optionsRuntime
      .runPromise(
        copyDiagnostics.pipe(
          Effect.as("Copied."),
          Effect.catchTag("UnknownError", () =>
            Effect.succeed("Couldn't copy to the clipboard.")
          )
        )
      )
      .then(setMessage)
  return (
    <Card>
      <CardHeader>
        <CardTitle>Diagnostics</CardTitle>
        <CardDescription>
          The relay's recent errors and broker codes state, as plain text to
          paste in an issue. Never includes the PIN or any token.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm">
          Errors kept: <output aria-label="Errors kept">{errors.length}</output>
        </p>
        <div className="flex items-center gap-4">
          <Button type="button" variant="outline" onClick={copy}>
            Copy diagnostics
          </Button>
          <p role="status" className="text-sm">
            {message}
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
