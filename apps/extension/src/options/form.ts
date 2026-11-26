import { Effect, Option, Schema } from "effect"

import { TargetUrl, type Settings } from "../worker/settings.ts"

class InvalidDashboardUrl extends Schema.TaggedError<InvalidDashboardUrl>()(
  "InvalidDashboardUrl",
  {}
) {}

// The options form as Settings. An empty extra URL means no extra target; any
// other is a TargetUrl of its origin and path, without a trailing slash, query
// or fragment, so a dashboard's root is read as its base path.
// Decision: a target's URL is stored under the key `origin`
// (apps/extension/docs/adr/0024-a-target-s-url-is-stored-under-the-key-origin.md)
export const settingsFromForm = Effect.fnUntraced(function* (form: {
  readonly productionToken: string
  readonly extraUrl: string
  readonly extraToken: string
}): Effect.fn.Return<Settings, InvalidDashboardUrl> {
  const productionToken = form.productionToken.trim()
  const extraUrl = form.extraUrl.trim()
  if (extraUrl === "") return { productionToken, extra: null }
  const url = Option.flatMap(
    Option.liftThrowable(() => new URL(extraUrl))(),
    ({ origin, pathname }) =>
      Schema.decodeUnknownOption(TargetUrl)(
        `${origin}${pathname.replace(/\/+$/, "")}`
      )
  )
  if (Option.isNone(url)) return yield* new InvalidDashboardUrl()
  return {
    productionToken,
    extra: { url: url.value, token: form.extraToken.trim() },
  }
})
