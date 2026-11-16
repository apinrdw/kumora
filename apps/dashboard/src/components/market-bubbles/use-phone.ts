import { useSyncExternalStore } from "react"

// Below Tailwind's `lg`, where Market Bubbles lays out for a phone (spec
// apinrdw/kumora#427, "Phone").
const PHONE = "(width < 64rem)"

const subscribe = (changed: () => void) => {
  const query = window.matchMedia(PHONE)
  query.addEventListener("change", changed)
  return () => query.removeEventListener("change", changed)
}

// Whether the window is phone-wide: false on the server, which can't know.
export const usePhone = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(PHONE).matches,
    () => false
  )
