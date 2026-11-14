// The hashes an archive keeps of a stored file, as lowercase hex.
import { Effect } from "effect"

export const sha256Hex = Effect.fnUntraced(function* (
  bytes: ArrayBuffer | Uint8Array<ArrayBuffer>
) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", bytes)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
})
