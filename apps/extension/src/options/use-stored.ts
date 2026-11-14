import { Effect } from "effect"
import { useEffect, useState } from "react"

import { optionsRuntime } from "./runtime.ts"

export type StorageChange = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string
) => Effect.Effect<boolean>

// A stored value, loaded at once and again on each change to it.
export function useStored<A>(
  load: Effect.Effect<A>,
  isChange: StorageChange,
  initial: A
) {
  const [value, setValue] = useState(initial)
  useEffect(() => {
    const refresh = () => void optionsRuntime.runPromise(load).then(setValue)
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (Effect.runSync(isChange(changes, area))) refresh()
    }
    refresh()
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [load, isChange])
  return value
}
