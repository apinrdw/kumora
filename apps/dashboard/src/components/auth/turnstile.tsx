import { clientRuntime } from "@workspace/client"
import { Data, Effect, Fiber } from "effect"
import { useCallback, useEffect, useRef, useState } from "react"

// The header Better Auth's captcha plugin reads the widget's token from.
export const CAPTCHA_HEADER = "x-captcha-response"

const SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

// The part of Cloudflare's script API used here.
interface TurnstileApi {
  readonly render: (
    element: HTMLElement,
    options: {
      sitekey: string
      callback: (token: string) => void
      "expired-callback": () => void
      "error-callback": () => void
    }
  ) => string
  readonly reset: (widgetId: string) => void
  readonly remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

class TurnstileDidNotLoad extends Data.TaggedError("TurnstileDidNotLoad") {}

let loading: Fiber.Fiber<TurnstileApi, TurnstileDidNotLoad> | undefined

const loadScript = Effect.callback<TurnstileApi, TurnstileDidNotLoad>(
  (resume) => {
    const script = document.createElement("script")
    script.src = SCRIPT
    script.async = true
    script.addEventListener("load", () =>
      resume(
        window.turnstile
          ? Effect.succeed(window.turnstile)
          : Effect.fail(new TurnstileDidNotLoad())
      )
    )
    script.addEventListener("error", () => {
      loading = undefined
      resume(Effect.fail(new TurnstileDidNotLoad()))
    })
    document.head.appendChild(script)
  }
)

// Loads Cloudflare's script once per page. The load runs in its own fiber, so
// a widget that unmounts mid-load stops waiting without cancelling it.
const loadTurnstile = Effect.suspend(() => {
  loading ??= clientRuntime.runFork(loadScript)
  return Fiber.join(loading)
})

/**
 * A Turnstile widget for a form: put `ref` on the element it renders into.
 * `token` is null until the visitor passes the check; a token works once, so
 * call `reset` after a refused submit.
 */
export function useTurnstile(siteKey: string) {
  // A callback ref, so the widget renders again when its element remounts.
  const [element, ref] = useState<HTMLDivElement | null>(null)
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null)
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    if (!element) return
    let mounted = true
    clientRuntime.runFork(
      Effect.flatMap(loadTurnstile, (api) =>
        Effect.sync(() => {
          if (!mounted) return
          const id = api.render(element, {
            sitekey: siteKey,
            callback: setToken,
            "expired-callback": () => setToken(null),
            "error-callback": () => setToken(null),
          })
          widget.current = { api, id }
        })
      )
    )
    return () => {
      mounted = false
      if (widget.current) widget.current.api.remove(widget.current.id)
      widget.current = null
      setToken(null)
    }
  }, [element, siteKey])

  const reset = useCallback(() => {
    setToken(null)
    if (widget.current) widget.current.api.reset(widget.current.id)
  }, [])

  return { ref, token, reset }
}
