// A stored file's MD5, as lowercase hex. Apart from hash.ts, which the admin
// pages' components reach through the archives' keys, so node:crypto stays
// out of the browser.
import { Effect } from "effect"
import { createHash } from "node:crypto"

// MD5 through node:crypto, which workerd serves under
// nodejs_compat: Web Crypto's digest has no MD5 in Node, where the tests
// run, and the KSEI archive compares a file's MD5 with its ETag
// (spec apinrdw/kumora#327, "R2 layout").
export const md5Hex = Effect.fnUntraced(function* (bytes: Uint8Array) {
  return createHash("md5").update(bytes).digest("hex")
})
