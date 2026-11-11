// The Worker's typecheck runs without Node's types; the nodejs_compat flag
// provides `node:zlib`, and the day store (day-store.ts) uses these two.
declare module "node:zlib" {
  export function gzipSync(data: string | Uint8Array): Uint8Array
  export function gunzipSync(data: Uint8Array): Uint8Array
}
