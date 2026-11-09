// A JWT's payload, read without verifying it: the relay only reads which user
// a broker tab's own token names.
import { Effect, Option } from "effect"
import * as Base64Url from "effect/encoding/Base64Url"

// The payload segment's JSON text; none when `token` isn't a JWT.
export const jwtPayloadText = Effect.fnUntraced(function* (token: string) {
  const segment = token.split(".")[1]
  if (segment === undefined) return Option.none<string>()
  return Option.getSuccess(Base64Url.decodeString(segment))
})
