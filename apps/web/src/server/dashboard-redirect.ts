import { Effect, Option } from "effect"

export const bareDashboardRedirect = Effect.fnUntraced(function* (
  _request: Request
) {
  return Option.none<Response>()
})
