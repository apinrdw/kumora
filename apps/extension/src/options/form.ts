import { Effect, Option, Schema } from "effect"

import { DashboardOrigin, type Settings } from "../worker/settings.ts"

class InvalidDashboardUrl extends Schema.TaggedError<InvalidDashboardUrl>()(
  "InvalidDashboardUrl",
  {}
) {}

// The options form as Settings. An empty extra URL means no extra target; any
// other is cut to its origin, so a pasted page URL works.
export const settingsFromForm = Effect.fnUntraced(function* (form: {
  readonly productionToken: string
  readonly extraUrl: string
  readonly extraToken: string
}): Effect.fn.Return<Settings, InvalidDashboardUrl> {
  const productionToken = form.productionToken.trim()
  const extraUrl = form.extraUrl.trim()
  if (extraUrl === "") return { productionToken, extra: null }
  const origin = Option.flatMap(
    Option.liftThrowable(() => new URL(extraUrl).origin)(),
    Schema.decodeUnknownOption(DashboardOrigin)
  )
  if (Option.isNone(origin)) return yield* new InvalidDashboardUrl()
  return {
    productionToken,
    extra: { origin: origin.value, token: form.extraToken.trim() },
  }
})
