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

let loading: Promise<TurnstileApi> | undefined

// Loads Cloudflare's script once per page.
function loadTurnstile(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = SCRIPT
    script.async = true
    script.addEventListener("load", () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error("Turnstile did not load"))
    )
    script.addEventListener("error", () => {
      loading = undefined
      reject(new Error("Turnstile did not load"))
    })
    document.head.appendChild(script)
  })
  return loading
}

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
    void loadTurnstile().then((api) => {
      if (!mounted) return
      const id = api.render(element, {
        sitekey: siteKey,
        callback: setToken,
        "expired-callback": () => setToken(null),
        "error-callback": () => setToken(null),
      })
      widget.current = { api, id }
    })
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
