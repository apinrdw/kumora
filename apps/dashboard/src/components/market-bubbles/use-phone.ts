import { useSyncExternalStore } from "react"

// Below Tailwind's `lg`, where Market Bubbles lays out for a phone (spec
// apinrdw/kumora#427, "Phone"). 64rem is Tailwind's default
// `--breakpoint-lg` (tailwindcss/theme.css), which styles.css keeps, so the
// `lg:` classes switch at the same width.
const PHONE = "(width < 64rem)"

const subscribe = (changed: () => void) => {
  const query = window.matchMedia(PHONE)
  query.addEventListener("change", changed)
  return () => query.removeEventListener("change", changed)
}

// Whether the window is phone-wide: undefined on the server and while the
// page hydrates, which can't know.
export const usePhone = (): boolean | undefined =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE).matches,
    () => undefined
  )
