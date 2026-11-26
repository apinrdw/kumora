import { StageUrl } from "@workspace/deploy/stage-url"
import { Effect, Option, Schema } from "effect"

import { type Settings } from "../worker/settings.ts"

class InvalidDashboardUrl extends Schema.TaggedError<InvalidDashboardUrl>()(
  "InvalidDashboardUrl",
  {}
) {}

// The options form as Settings. An empty extra URL means no extra target; any
// other keeps its origin and path, without a trailing slash, query or
// fragment, so a dashboard served under a path such as `/dashboard` is
// reached there.
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
      Schema.decodeUnknownOption(StageUrl)(
        `${origin}${pathname.replace(/\/+$/, "")}`
      )
  )
  if (Option.isNone(url)) return yield* new InvalidDashboardUrl()
  return {
    productionToken,
    extra: { url: url.value, token: form.extraToken.trim() },
  }
})
