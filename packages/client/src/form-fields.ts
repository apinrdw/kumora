import { Effect } from "effect"

/** The named fields of a submitted form, as text: a missing or File field is "". */
export const formFields = <K extends string>(
  form: HTMLFormElement,
  names: ReadonlyArray<K>
): Effect.Effect<Record<K, string>> =>
  Effect.sync(() => {
    const data = new FormData(form)
    return Object.fromEntries(
      names.map((name) => {
        const value = data.get(name)
        return [name, typeof value === "string" ? value : ""]
      })
    ) as Record<K, string>
  })
